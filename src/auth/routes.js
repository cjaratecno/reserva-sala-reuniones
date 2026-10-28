const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { query } = require('../db');
const { asyncH, normalizarUsuario } = require('../middleware');
const { scopesLogin, crearCliente, CryptoProvider } = require('./msal');
const { llamarGraph } = require('../graph');
const { obtenerConfigSso } = require('../sso-config');

const router = express.Router();
const crypto = new CryptoProvider();

/** Regenera el id de sesión (evita session fixation) y guarda los datos dados. */
function iniciarSesion(req, datos) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, datos);
      req.session.save((err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

// ------------------------------------------------------------------
// SSO Microsoft 365 (OAuth 2.0 Authorization Code + PKCE)
// ------------------------------------------------------------------
// Usado por la página de login para mostrar u ocultar el botón de Microsoft 365
router.get('/estado', asyncH(async (req, res) => {
  const cfg = await obtenerConfigSso();
  res.json({ sso: cfg.habilitado });
}));

router.get('/login', asyncH(async (req, res) => {
  const cfg = await obtenerConfigSso();
  if (!cfg.habilitado) return res.redirect('/login?error=sso_no_configurado');

  const { verifier, challenge } = await crypto.generatePkceCodes();
  const state = crypto.createNewGuid();
  req.session.oauth = { verifier, state };

  const url = await crearCliente(cfg, {}).getAuthCodeUrl({
    scopes: scopesLogin(cfg),
    redirectUri: config.redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state,
    prompt: 'select_account',
  });
  req.session.save(() => res.redirect(url));
}));

router.get('/callback', asyncH(async (req, res) => {
  const oauth = req.session.oauth;
  delete req.session.oauth;

  if (req.query.error) {
    console.warn('Error devuelto por Microsoft:', req.query.error, req.query.error_description);
    return res.redirect('/login?error=microsoft');
  }
  if (!oauth || !req.query.code || req.query.state !== oauth.state) {
    return res.redirect('/login?error=estado_invalido');
  }

  const cfg = await obtenerConfigSso();
  if (!cfg.habilitado) return res.redirect('/login?error=sso_no_configurado');

  const almacen = {}; // caché MSAL temporal hasta regenerar la sesión
  let resultado;
  try {
    resultado = await crearCliente(cfg, almacen).acquireTokenByCode({
      code: req.query.code,
      scopes: scopesLogin(cfg),
      redirectUri: config.redirectUri,
      codeVerifier: oauth.verifier,
    });
  } catch (err) {
    console.error('Error canjeando el código de Microsoft:', err.errorCode || '', err.errorMessage || err.message);
    return res.redirect('/login?error=microsoft');
  }

  const claims = resultado.idTokenClaims;
  // El UPN no siempre coincide con el correo: se consulta el mail real
  const perfil = await llamarGraph(resultado.accessToken, 'GET', '/me?$select=mail,userPrincipalName,displayName');
  const email = (perfil.mail || perfil.userPrincipalName || claims.preferred_username).toLowerCase();
  const nombre = perfil.displayName || claims.name || email;

  const dominio = email.split('@')[1];
  if (cfg.dominiosPermitidos.length && !cfg.dominiosPermitidos.includes(dominio)) {
    return res.redirect('/login?error=dominio_no_permitido');
  }

  const { rows: [usuario] } = await query(
    `INSERT INTO usuarios (tipo, azure_oid, email, nombre, ultimo_acceso)
     VALUES ('o365', $1, $2, $3, now())
     ON CONFLICT (azure_oid) DO UPDATE
       SET email = EXCLUDED.email, nombre = EXCLUDED.nombre, ultimo_acceso = now()
     RETURNING id, activo`,
    [claims.oid, email, nombre]
  );
  if (!usuario.activo) return res.redirect('/login?error=usuario_inactivo');

  await iniciarSesion(req, {
    usuario: { id: usuario.id, tipo: 'o365', nombre, email, homeAccountId: resultado.account.homeAccountId },
    msalCache: almacen.msalCache,
  });
  res.redirect('/');
}));

// ------------------------------------------------------------------
// Login de administradores (usuario + contraseña local)
// ------------------------------------------------------------------
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const intentos = new Map(); // ip -> { n, bloqueadoHasta }
// Hash ficticio para que el tiempo de respuesta no revele si el usuario existe
const HASH_FICTICIO = bcrypt.hashSync('contraseña-ficticia', 10);

router.post('/admin', asyncH(async (req, res) => {
  const ip = req.ip;
  const registro = intentos.get(ip) || { n: 0, bloqueadoHasta: 0 };
  if (registro.bloqueadoHasta > Date.now()) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Espere 15 minutos.' });
  }

  const { usuario, password } = req.body || {};
  if (typeof usuario !== 'string' || typeof password !== 'string' || !usuario || !password) {
    return res.status(400).json({ error: 'Ingrese usuario y contraseña' });
  }

  const { rows: [admin] } = await query(
    `SELECT id, nombre, email, password_hash, activo, solo_lectura FROM usuarios WHERE tipo = 'admin' AND username = $1`,
    [normalizarUsuario(usuario)]
  );
  const valido = await bcrypt.compare(password, admin?.password_hash || HASH_FICTICIO);

  if (!admin || !admin.activo || !valido) {
    registro.n += 1;
    if (registro.n >= MAX_INTENTOS) {
      registro.n = 0;
      registro.bloqueadoHasta = Date.now() + BLOQUEO_MS;
    }
    intentos.set(ip, registro);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  intentos.delete(ip);
  await query('UPDATE usuarios SET ultimo_acceso = now() WHERE id = $1', [admin.id]);
  await iniciarSesion(req, {
    // 'visor' = cuenta de solo visualización (ej. Recepción): no pasa ningún control de administrador
    usuario: { id: admin.id, tipo: admin.solo_lectura ? 'visor' : 'admin', nombre: admin.nombre, email: admin.email },
  });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------
router.get('/logout', asyncH(async (req, res) => {
  const eraO365 = req.session.usuario?.tipo === 'o365';
  const cfg = await obtenerConfigSso();
  req.session.destroy(() => {
    res.clearCookie('reserva.sid');
    if (eraO365 && cfg.tenantId) {
      const vuelta = encodeURIComponent(`${config.baseUrl}/login`);
      return res.redirect(
        `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/logout?post_logout_redirect_uri=${vuelta}`
      );
    }
    res.redirect('/login');
  });
}));

module.exports = router;
