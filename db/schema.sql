-- =============================================================
-- Sistema de reservas de salas de reuniones - Esquema PostgreSQL
-- Idempotente: se puede ejecutar varias veces sin romper datos.
-- =============================================================

-- Necesaria para impedir reservas solapadas con un EXCLUDE constraint
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -------------------------------------------------------------
-- Usuarios: administradores (login local, los crea otro admin) y
-- usuarios que ingresan por SSO de Microsoft 365 (se crean al
-- primer login y solo pueden reservar)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
    id             SERIAL PRIMARY KEY,
    tipo           VARCHAR(10)  NOT NULL CHECK (tipo IN ('admin', 'o365')),
    username       VARCHAR(50)  UNIQUE,          -- solo admin
    password_hash  TEXT,                         -- solo admin (bcrypt)
    azure_oid      UUID         UNIQUE,          -- solo o365 (object id de Entra ID)
    email          VARCHAR(255),
    nombre         VARCHAR(200) NOT NULL,
    activo         BOOLEAN      NOT NULL DEFAULT TRUE,
    creado_en      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    ultimo_acceso  TIMESTAMPTZ,
    CONSTRAINT chk_usuario_admin CHECK (tipo <> 'admin' OR (username IS NOT NULL AND password_hash IS NOT NULL)),
    CONSTRAINT chk_usuario_o365  CHECK (tipo <> 'o365'  OR azure_oid IS NOT NULL)
);

-- Se permiten varios administradores (versiones anteriores limitaban a uno)
DROP INDEX IF EXISTS ux_usuarios_admin_unico;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS creado_por INTEGER REFERENCES usuarios(id);
-- Cuentas locales de solo visualización (ej. Recepción): ven el calendario, no crean ni cancelan
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS solo_lectura BOOLEAN NOT NULL DEFAULT FALSE;

-- Administrador inicial (usuario "admin"). Solo se guarda el hash bcrypt de la contraseña.
INSERT INTO usuarios (tipo, username, password_hash, nombre)
SELECT 'admin', 'admin', '$2a$12$HMml7oR/aHRKYGofOuLgW.l/WenFYC11Cw5CrOwxdY90eMudCD8Wi', 'Administrador'
WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE tipo = 'admin' AND NOT solo_lectura);

-- Cuenta de Recepción (solo visualización). Usuario "recepcion" (también acepta "Recepción" al ingresar).
INSERT INTO usuarios (tipo, username, password_hash, nombre, solo_lectura)
VALUES ('admin', 'recepcion', '$2a$12$r8QER/Nak7sOcS3RSQT.zOMmm09ZzxSmFAxNKkeDUvDsVVGCXLATW', 'Recepción', TRUE)
ON CONFLICT (username) DO NOTHING;

-- -------------------------------------------------------------
-- Configuración del SSO de Microsoft 365 (una sola fila, id = 1).
-- Se edita desde la página de administración; el secreto de
-- cliente se guarda cifrado con AES-256-GCM.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config_sso (
    id                     SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    tenant_id              VARCHAR(100),
    client_id              VARCHAR(100),
    client_secret_cifrado  TEXT,
    secreto_vence          DATE,
    dominios_permitidos    TEXT,
    permisos_aplicacion    BOOLEAN      NOT NULL DEFAULT FALSE,
    buzon_admin            VARCHAR(255),
    actualizado_en         TIMESTAMPTZ,
    actualizado_por        INTEGER      REFERENCES usuarios(id)
);
INSERT INTO config_sso (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
-- Correo de confirmación al solicitante (requiere permiso delegado Mail.Send)
ALTER TABLE config_sso ADD COLUMN IF NOT EXISTS enviar_confirmacion BOOLEAN NOT NULL DEFAULT FALSE;

-- -------------------------------------------------------------
-- Salas
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS salas (
    id             SERIAL PRIMARY KEY,
    nombre         VARCHAR(100) NOT NULL UNIQUE,
    ubicacion      VARCHAR(200),
    capacidad      INTEGER CHECK (capacidad IS NULL OR capacidad > 0),
    email_recurso  VARCHAR(255),                 -- buzón de recurso (room mailbox) en Exchange, opcional
    color          VARCHAR(7)   NOT NULL DEFAULT '#2563eb',
    activa         BOOLEAN      NOT NULL DEFAULT TRUE,
    creado_en      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- Reservas
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservas (
    id                  SERIAL PRIMARY KEY,
    sala_id             INTEGER      NOT NULL REFERENCES salas(id),
    organizador_id      INTEGER      NOT NULL REFERENCES usuarios(id),
    organizador_email   VARCHAR(255) NOT NULL,   -- buzón donde vive el evento de Outlook
    titulo              VARCHAR(255) NOT NULL,
    descripcion         TEXT,
    inicio              TIMESTAMPTZ  NOT NULL,
    fin                 TIMESTAMPTZ  NOT NULL,
    reunion_teams       BOOLEAN      NOT NULL DEFAULT FALSE,
    link_teams          TEXT,
    estado              VARCHAR(12)  NOT NULL DEFAULT 'confirmada' CHECK (estado IN ('confirmada', 'cancelada')),
    graph_event_id      TEXT,                    -- id del evento en Microsoft Graph
    cancelada_por       INTEGER      REFERENCES usuarios(id),
    motivo_cancelacion  TEXT,
    creado_en           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    actualizado_en      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT chk_reserva_rango CHECK (fin > inicio),
    -- Impide a nivel de BD dos reservas confirmadas de la misma sala que se solapen
    CONSTRAINT reservas_sin_solape EXCLUDE USING gist (
        sala_id WITH =,
        tstzrange(inicio, fin, '[)') WITH &&
    ) WHERE (estado = 'confirmada')
);

CREATE INDEX IF NOT EXISTS ix_reservas_rango       ON reservas (inicio, fin);
CREATE INDEX IF NOT EXISTS ix_reservas_organizador ON reservas (organizador_id);

-- -------------------------------------------------------------
-- Asistentes invitados a cada reserva
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserva_asistentes (
    id          SERIAL PRIMARY KEY,
    reserva_id  INTEGER      NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
    email       VARCHAR(255) NOT NULL,
    nombre      VARCHAR(200),
    CONSTRAINT ux_reserva_asistente UNIQUE (reserva_id, email)
);

-- -------------------------------------------------------------
-- Sesiones web (usada por connect-pg-simple)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "session" (
    "sid"    VARCHAR      NOT NULL COLLATE "default" PRIMARY KEY,
    "sess"   JSON         NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Sala inicial
INSERT INTO salas (nombre, ubicacion, capacidad)
VALUES ('Sala de Reuniones', 'Oficina principal', 10)
ON CONFLICT (nombre) DO NOTHING;
