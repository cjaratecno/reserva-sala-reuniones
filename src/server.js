const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);

const config = require('./config');
const { pool } = require('./db');
const { asyncH, requiereSesion } = require('./middleware');
const { obtenerConfigSso } = require('./sso-config');

const app = express();
const PUBLIC = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

// Healthcheck para Docker
app.get('/health', asyncH(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.use(express.json({ limit: '100kb' }));
app.use(
  session({
    store: new PgStore({ pool, tableName: 'session' }),
    name: 'reserva.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.cookieSegura, maxAge: 8 * 60 * 60 * 1000 },
  })
);
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});

// --- Autenticación ---
app.use('/auth', require('./auth/routes'));

// --- API (requiere sesión) ---
app.use('/api', requiereSesion);

app.get('/api/me', asyncH(async (req, res) => {
  const { id, tipo, nombre, email } = req.session.usuario;
  const cfg = await obtenerConfigSso();
  res.json({
    id, tipo, nombre, email,
    puedeReservar: tipo === 'o365' || (tipo === 'admin' && Boolean(cfg.buzonAdmin)),
    puedeBuscarPersonas: tipo === 'o365' || (tipo === 'admin' && cfg.appHabilitada),
    // Fotos de perfil: usuarios Microsoft 365, o cuentas locales si hay permisos de aplicación
    puedeVerFotos: tipo === 'o365' || cfg.appHabilitada,
    // Agenda de los invitados al reservar (getSchedule necesita un buzón)
    puedeVerAgendas: tipo === 'o365' || (tipo === 'admin' && Boolean(cfg.buzonAdmin)),
    soloLectura: tipo === 'visor',
  });
}));

app.use('/api/directorio', require('./routes/directorio'));
app.use('/api/reservas', require('./routes/reservas'));
app.use('/api/sala', require('./routes/salas').router);
app.use('/api/admin', require('./routes/admin'));

// --- Páginas ---
app.get('/login', (req, res) => (req.session.usuario ? res.redirect('/') : res.sendFile(path.join(PUBLIC, 'login.html'))));
app.get('/', requiereSesion, (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.use(express.static(PUBLIC, { index: false }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// --- Manejo de errores ---
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const mensaje = status >= 500 ? err.mensajePublico || 'Error interno del servidor' : err.message;
  if (req.originalUrl.startsWith('/api') || req.method !== 'GET') return res.status(status).json({ error: mensaje });
  res.redirect('/login?error=interno');
});

app.listen(config.port, () => {
  console.log(`Reserva de salas escuchando en ${config.baseUrl} (puerto ${config.port})`);
  obtenerConfigSso()
    .then((cfg) => {
      if (!cfg.habilitado) console.warn('⚠ SSO de Microsoft 365 sin configurar: ingrese como administrador → Configuración.');
      if (cfg.secretoIlegible) console.warn('⚠ No se pudo descifrar el secreto de Microsoft 365 (cambió CLAVE_CIFRADO/SESSION_SECRET): vuelva a ingresarlo.');
    })
    .catch(() => {});
});
