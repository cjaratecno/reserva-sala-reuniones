# Reserva Sala de Reuniones

Sistema web para reservar **la sala de reuniones** de Tecnodata con:

- **Dos tipos de acceso**
  - **Administradores** (usuario + contraseña local, guardada como hash bcrypt). Solo un administrador puede
    crear otros administradores. Administran los datos de la sala, la configuración de Microsoft 365 y pueden cancelar cualquier reserva.
  - **Usuarios Microsoft 365** por SSO (Entra ID, OAuth 2.0 + PKCE). Se registran solos al primer ingreso y
    **solo pueden reservar** (y cancelar sus propias reservas).
- **Configuración del SSO desde la web**: tenant, Id. de aplicación y secreto se ingresan en
  *Configuración* (el secreto se guarda cifrado). Al guardar se verifica contra Microsoft, y se avisa
  30 días antes de que venza el secreto.
- **Calendario** (día / semana / mes / lista) con todas las reservas.
- **Invitaciones automáticas**: al reservar, el evento se crea en el calendario de Outlook de quien solicita
  mediante Microsoft Graph, y Exchange envía la invitación a cada asistente; la reunión queda en el calendario
  personal de todos. Opcionalmente agrega enlace de Microsoft Teams.
- **Cancelación**: el organizador (o el admin) cancela y Outlook envía la cancelación a todos los invitados.
- **Sin choques de horario**: el formulario avisa en vivo con qué reunión choca, y PostgreSQL lo garantiza con un
  `EXCLUDE` constraint (aun con reservas simultáneas). Una reunión puede empezar justo cuando termina otra.

Stack: Node.js 20, Express, PostgreSQL 16, MSAL Node, Microsoft Graph, FullCalendar — todo en Docker.

## Estructura

```
Dockerfile               Imagen de la aplicación
docker-compose.yml       App + PostgreSQL
db/schema.sql            Tablas PostgreSQL
scripts/init-db.js       Crea/actualiza las tablas (se ejecuta al arrancar el contenedor)
scripts/crear-admin.js   Recuperación: crea un admin o restablece su contraseña desde la consola
src/server.js            Servidor Express
src/auth/                Login SSO Microsoft 365 y login de administradores
src/sso-config.js        Configuración del SSO guardada en la BD (secreto cifrado AES-256-GCM)
src/graph.js             Llamadas a Microsoft Graph (crear/cancelar eventos, buscar personas)
src/routes/              API de reservas, datos de la sala y administración
public/                  Frontend (login + calendario)
docs/                    Guía de configuración de Microsoft 365
```

### Modelo de datos

| Tabla | Descripción |
|---|---|
| `usuarios` | `tipo` = `admin` (username + password_hash bcrypt) u `o365` (azure_oid). `creado_por` registra qué admin lo creó. |
| `config_sso` | Fila única con tenant, client id, secreto **cifrado**, vencimiento del secreto, dominios permitidos y permisos opcionales. |
| `salas` | Una sola fila: la sala de reuniones (nombre, ubicación, capacidad, color, buzón de recurso de Exchange, habilitada). |
| `reservas` | Sala, organizador, título, inicio/fin, estado (`confirmada`/`cancelada`), id del evento en Graph, link Teams. |
| `reserva_asistentes` | Correos invitados por reserva. |
| `session` | Sesiones web (connect-pg-simple). |

## 1. Instalación con Docker

Requisitos: Docker Desktop (Windows/Mac) o Docker Engine + Compose (Linux).

```powershell
Copy-Item .env.example .env       # en Linux: cp .env.example .env
# Edite .env: SESSION_SECRET, POSTGRES_PASSWORD y BASE_URL
docker compose up -d --build
```

Abra http://localhost:3000 (o el `APP_PORT` definido) → **Acceso administrador** → usuario `admin`
con la contraseña inicial entregada. Cámbiela en **Configuración → Mi contraseña** si corresponde.

Al arrancar, el contenedor `app` automáticamente:

1. espera a que PostgreSQL (contenedor `db`) esté listo,
2. crea/actualiza las tablas (`db/schema.sql`) y, si no hay ningún administrador, crea el usuario `admin`,
3. levanta el servidor.

## 2. Configurar Microsoft 365 (Entra ID + Graph)

1. Cree el registro de aplicación en Azure siguiendo [docs/CONFIGURAR-MICROSOFT-365.md](docs/CONFIGURAR-MICROSOFT-365.md).
2. En la app, como administrador → **Configuración → Microsoft 365 (SSO)**: pegue el Id. de directorio,
   el Id. de aplicación, el secreto y su fecha de vencimiento → **Guardar**.

Cuando el secreto esté por vencer, la app lo avisa a los administradores: se genera uno nuevo en Azure y
se pega en la misma pantalla, **sin tocar el `.env` ni reiniciar contenedores**.

### Comandos útiles

| Acción | Comando |
|---|---|
| Ver logs | `docker compose logs -f app` |
| Aplicar cambios del `.env` | `docker compose up -d` |
| Actualizar tras cambiar código | `docker compose up -d --build` |
| Recuperar acceso (olvido de clave) | `docker compose exec app node scripts/crear-admin.js admin "NuevaClave123"` |
| Consola SQL | `docker compose exec db psql -U reservas -d reserva_salas` |
| Respaldo de la BD | `docker compose exec db pg_dump -U reservas reserva_salas > respaldo.sql` |
| Detener | `docker compose down` (los datos quedan en el volumen `pgdata`) |

> ⚠ `docker compose down -v` **borra el volumen y todos los datos**.

### Desarrollo sin Docker para la app

Con un PostgreSQL propio, defina `DATABASE_URL` en `.env` y ejecute `npm install`, `npm run db:init`,
`npm run crear-admin -- admin "Clave12345" "Admin"` y `npm run dev`.

## 3. Variables de entorno

Todas están documentadas en [.env.example](.env.example).

## Funcionamiento

- **Usuario Microsoft 365**: ve el calendario, selecciona un horario, elige sala, busca invitados en el
  directorio de la empresa (o escribe correos externos) y confirma. El evento se crea en *su* Outlook como
  organizador; los invitados reciben la invitación y pueden aceptar/rechazar. Puede cancelar sus propias reservas.
  No tiene acceso a salas, configuración ni administradores.
- **Administrador**: ve todas las reservas, edita los datos de la sala (o la marca fuera de servicio), configura Microsoft 365,
  crea/edita/desactiva otros administradores y cancela cualquier reserva. No puede desactivarse a sí mismo y
  siempre debe quedar al menos un administrador activo. Sin permisos de aplicación, al cancelar se libera la sala
  pero el organizador debe cancelar en Outlook. Para que un admin pueda *crear* reservas, habilite el buzón
  organizador en Configuración (ej. un buzón compartido).
- **Sala con buzón de recurso** (`email_recurso`): si la sala existe como *room mailbox* en Exchange, se
  agrega como recurso a la reunión, de modo que también aparezca ocupada en Outlook.

## Producción

- Publique la app detrás de un proxy inverso con **HTTPS** (Nginx, IIS, Traefik...) apuntando al puerto `APP_PORT`.
- En `.env`: `BASE_URL=https://su-dominio` (la cookie se marca `secure` automáticamente) y `TRUST_PROXY=true`.
- Registre `https://su-dominio/auth/callback` en la App Registration (paso 4 de la guía).
- Programe respaldos periódicos de la base de datos (ver comandos útiles).
