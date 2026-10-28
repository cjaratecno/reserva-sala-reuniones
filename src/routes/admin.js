// API exclusiva de administradores: configuración del SSO y gestión de administradores
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { query } = require('../db');
const { HttpError, asyncH, requiereAdmin, normalizarUsuario } = require('../middleware');
const { obtenerConfigSso, guardarConfigSso } = require('../sso-config');
const { probarCredenciales } = require('../auth/msal');

const router = express.Router();
router.use(requiereAdmin);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMINIO_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,50}$/;
const MIN_PASSWORD = 8;

const texto = (v, max = 255) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ------------------------------------------------------------------
// Configuración SSO Microsoft 365
// ------------------------------------------------------------------
router.get('/sso', asyncH(async (req, res) => {
  const cfg = await obtenerConfigSso();
  const { rows: [r] } = await query(
    `SELECT c.dominios_permitidos, c.permisos_aplicacion, c.buzon_admin, c.client_secret_cifrado IS NOT NULL AS tiene_secreto,
            c.enviar_confirmacion, c.actualizado_en, u.nombre AS actualizado_por
       FROM config_sso c LEFT JOIN usuarios u ON u.id = c.actualizado_por WHERE c.id = 1`
  );
  res.json({
    tenantId: cfg.tenantId || '',
    clientId: cfg.clientId || '',
    secretoConfigurado: r.tiene_secreto && !cfg.secretoIlegible,
    secretoIlegible: cfg.secretoIlegible,
    secretoVence: cfg.secretoVence || '',
    dominiosPermitidos: r.dominios_permitidos || '',
    permisosAplicacion: r.permisos_aplicacion,
    buzonAdmin: r.buzon_admin || '',
    enviarConfirmacion: r.enviar_confirmacion,
    habilitado: cfg.habilitado,
    redirectUri: config.redirectUri,
    actualizadoEn: r.actualizado_en,
    actualizadoPor: r.actualizado_por,
  });
}));

/** Valida el cuerpo del formulario SSO; completa el secreto con el guardado si viene vacío. */
async function leerFormularioSso(body = {}) {
  const tenantId = texto(body.tenantId, 100);
  const clientId = texto(body.clientId, 100);
  const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
  if (!GUID_RE.test(tenantId) && !DOMINIO_RE.test(tenantId)) {
    throw new HttpError(400, 'Id. de directorio (tenant) inválido: debe ser un GUID o un dominio (empresa.onmicrosoft.com)');
  }
  if (!GUID_RE.test(clientId)) throw new HttpError(400, 'Id. de aplicación (cliente) inválido: debe ser un GUID');
  if (clientSecret.length > 500) throw new HttpError(400, 'Secreto de cliente demasiado largo');

  const secretoVence = texto(body.secretoVence, 10) || null;
  if (secretoVence && (!/^\d{4}-\d{2}-\d{2}$/.test(secretoVence) || Number.isNaN(Date.parse(secretoVence)))) {
    throw new HttpError(400, 'Fecha de vencimiento inválida');
  }

  const dominios = texto(body.dominiosPermitidos, 1000)
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const malo = dominios.find((d) => !DOMINIO_RE.test(d));
  if (malo) throw new HttpError(400, `Dominio inválido: ${malo}`);

  const permisosAplicacion = body.permisosAplicacion === true;
  const buzonAdmin = texto(body.buzonAdmin).toLowerCase() || null;
  if (buzonAdmin && !EMAIL_RE.test(buzonAdmin)) throw new HttpError(400, 'Correo del buzón organizador inválido');

  const actual = await obtenerConfigSso();
  const secretoEfectivo = clientSecret || actual.clientSecret;
  if (!secretoEfectivo) throw new HttpError(400, 'Ingrese el secreto de cliente (Valor)');

  return {
    tenantId,
    clientId,
    clientSecret, // vacío = conservar el actual
    secretoEfectivo,
    secretoVence,
    dominiosPermitidos: dominios.join(', ') || null,
    permisosAplicacion,
    buzonAdmin,
    enviarConfirmacion: body.enviarConfirmacion === true,
  };
}

router.post('/sso/probar', asyncH(async (req, res) => {
  const d = await leerFormularioSso(req.body);
  const error = await probarCredenciales({ tenantId: d.tenantId, clientId: d.clientId, clientSecret: d.secretoEfectivo });
  if (error) throw new HttpError(400, error);
  res.json({ ok: true, mensaje: 'Conexión exitosa: Microsoft aceptó el tenant, el Id. de aplicación y el secreto.' });
}));

router.put('/sso', asyncH(async (req, res) => {
  const d = await leerFormularioSso(req.body);
  // No se guarda una configuración que Microsoft rechaza: evita dejar a todos sin poder entrar
  const error = await probarCredenciales({ tenantId: d.tenantId, clientId: d.clientId, clientSecret: d.secretoEfectivo });
  if (error) throw new HttpError(400, `No se guardó. ${error}`);
  await guardarConfigSso(d, req.session.usuario.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------
// Administradores
// ------------------------------------------------------------------
router.get('/administradores', asyncH(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.username, a.nombre, a.email, a.activo, a.solo_lectura, a.creado_en, a.ultimo_acceso, c.nombre AS creado_por
       FROM usuarios a LEFT JOIN usuarios c ON c.id = a.creado_por
      WHERE a.tipo = 'admin' ORDER BY a.nombre`
  );
  res.json(rows.map((r) => ({ ...r, esYo: r.id === req.session.usuario.id })));
}));

function validarPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
  }
  if (password.length > 72) throw new HttpError(400, 'La contraseña no puede superar 72 caracteres');
}

function leerAdmin(body = {}) {
  const nombre = texto(body.nombre, 200);
  if (!nombre) throw new HttpError(400, 'El nombre es obligatorio');
  const email = texto(body.email).toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'Correo inválido');
  return { nombre, email };
}

router.post('/administradores', asyncH(async (req, res) => {
  const username = normalizarUsuario(texto(req.body?.username, 50));
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Usuario inválido: 3 a 50 caracteres (letras, números, punto, guion o guion bajo)');
  }
  const { nombre, email } = leerAdmin(req.body);
  const soloLectura = req.body?.soloLectura === true;
  validarPassword(req.body?.password);
  const hash = await bcrypt.hash(req.body.password, 12);
  try {
    const { rows: [admin] } = await query(
      `INSERT INTO usuarios (tipo, username, password_hash, nombre, email, solo_lectura, creado_por)
       VALUES ('admin', $1, $2, $3, $4, $5, $6) RETURNING id, username, nombre, email, activo, solo_lectura`,
      [username, hash, nombre, email, soloLectura, req.session.usuario.id]
    );
    res.status(201).json(admin);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Ya existe un usuario con ese nombre de usuario');
    throw err;
  }
}));

router.put('/administradores/:id', asyncH(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10) || 0;
  const { nombre, email } = leerAdmin(req.body);
  const activo = req.body?.activo !== false;
  const soloLectura = req.body?.soloLectura === true;
  const nuevaPassword = typeof req.body?.password === 'string' && req.body.password ? req.body.password : null;
  if (nuevaPassword) validarPassword(nuevaPassword);

  if (id === req.session.usuario.id) {
    if (!activo) throw new HttpError(400, 'No puede desactivar su propio usuario');
    if (soloLectura) throw new HttpError(400, 'No puede quitarse a sí mismo los permisos de administrador');
  }
  if (!activo || soloLectura) {
    // Siempre debe quedar al menos un administrador completo activo
    const { rows: [{ n }] } = await query(
      `SELECT count(*)::int AS n FROM usuarios WHERE tipo = 'admin' AND activo AND NOT solo_lectura AND id <> $1`,
      [id]
    );
    if (n === 0) throw new HttpError(400, 'Debe quedar al menos un administrador completo activo');
  }

  const hash = nuevaPassword ? await bcrypt.hash(nuevaPassword, 12) : null;
  const { rows: [admin] } = await query(
    `UPDATE usuarios SET nombre = $1, email = $2, activo = $3, solo_lectura = $4, password_hash = COALESCE($5, password_hash)
      WHERE id = $6 AND tipo = 'admin' RETURNING id, username, nombre, email, activo, solo_lectura`,
    [nombre, email, activo, soloLectura, hash, id]
  );
  if (!admin) throw new HttpError(404, 'Administrador no encontrado');
  if (id === req.session.usuario.id) Object.assign(req.session.usuario, { nombre, email });
  res.json(admin);
}));

// Cambio de la contraseña propia
router.put('/mi-password', asyncH(async (req, res) => {
  const { actual, nueva } = req.body || {};
  if (typeof actual !== 'string' || !actual) throw new HttpError(400, 'Ingrese su contraseña actual');
  validarPassword(nueva);
  const { rows: [u] } = await query('SELECT password_hash FROM usuarios WHERE id = $1', [req.session.usuario.id]);
  if (!(await bcrypt.compare(actual, u.password_hash))) throw new HttpError(400, 'La contraseña actual es incorrecta');
  await query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(nueva, 12), req.session.usuario.id]);
  res.json({ ok: true });
}));

module.exports = router;
