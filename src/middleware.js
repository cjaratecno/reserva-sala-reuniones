const { query } = require('./db');

class HttpError extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

/** Envuelve handlers async para que los errores lleguen al error handler de Express. */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Nombre de usuario local sin tildes y en minúsculas ("Recepción" → "recepcion"). */
const normalizarUsuario = (u) =>
  String(u || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Exige sesión y que el usuario siga activo (un admin puede haber sido desactivado).
 * Para cuentas locales refresca el rol, por si un admin lo cambió a solo visualización o al revés.
 */
const requiereSesion = asyncH(async (req, res, next) => {
  const u = req.session.usuario;
  if (u) {
    const { rows: [r] } = await query('SELECT activo, tipo, solo_lectura FROM usuarios WHERE id = $1', [u.id]);
    if (r?.activo) {
      if (r.tipo === 'admin') u.tipo = r.solo_lectura ? 'visor' : 'admin';
      return next();
    }
    await new Promise((resolve) => req.session.destroy(resolve));
  }
  if (req.originalUrl.startsWith('/api')) return res.status(401).json({ error: 'No autenticado' });
  return res.redirect('/login');
});

function requiereAdmin(req, res, next) {
  if (req.session.usuario?.tipo === 'admin') return next();
  return res.status(403).json({ error: 'Solo un administrador puede realizar esta acción' });
}

/** Bloquea a las cuentas de solo visualización (Recepción). */
function noVisor(req, res, next) {
  if (req.session.usuario?.tipo !== 'visor') return next();
  return res.status(403).json({ error: 'Su cuenta es de solo visualización' });
}

module.exports = { HttpError, asyncH, normalizarUsuario, requiereSesion, requiereAdmin, noVisor };
