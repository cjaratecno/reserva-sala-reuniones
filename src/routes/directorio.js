// Directorio de Microsoft 365: búsqueda de personas, fotos de perfil y agenda (disponibilidad)
const express = require('express');
const { HttpError, asyncH, noVisor } = require('../middleware');
const { obtenerTokenUsuario, obtenerTokenApp } = require('../auth/msal');
const { obtenerConfigSso } = require('../sso-config');
const { buscarPersonas, obtenerFoto, obtenerAgendas } = require('../graph');

const router = express.Router();

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const MAX_AGENDAS = 50;
const MAX_VENTANA_MS = 24 * 60 * 60 * 1000;

/**
 * Token para leer el directorio:
 * - usuario Microsoft 365: su token delegado (base '/me')
 * - admin / visor: token de aplicación si están habilitados los permisos de aplicación
 *   (base = buzón organizador, necesario para consultar agendas)
 */
async function contextoLectura(req) {
  const u = req.session.usuario;
  if (u.tipo === 'o365') return { token: await obtenerTokenUsuario(req.session), base: '/me' };
  const cfg = await obtenerConfigSso();
  if (!cfg.appHabilitada) return null;
  return {
    token: await obtenerTokenApp(),
    base: cfg.buzonAdmin ? `/users/${encodeURIComponent(cfg.buzonAdmin)}` : null,
  };
}

// ------------------------------------------------------------------
// Búsqueda de personas para invitarlas
// ------------------------------------------------------------------
router.get('/', noVisor, asyncH(async (req, res) => {
  const texto = String(req.query.q || '').trim().slice(0, 100);
  if (texto.length < 2) return res.json([]);
  const ctx = await contextoLectura(req);
  if (!ctx) return res.json([]);
  res.json(await buscarPersonas(ctx.token, texto));
}));

// ------------------------------------------------------------------
// Foto de perfil (con caché en memoria; 404 si no tiene foto → la página muestra las iniciales)
// ------------------------------------------------------------------
const TTL_FOTO_MS = 60 * 60 * 1000;
const MAX_FOTOS_CACHE = 2000;
const cacheFotos = new Map(); // email -> { foto: {datos, tipo} | null, expira }

router.get('/foto', asyncH(async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 255) throw new HttpError(400, 'Correo inválido');

  let entrada = cacheFotos.get(email);
  if (!entrada || entrada.expira < Date.now()) {
    const ctx = await contextoLectura(req).catch(() => null);
    const foto = ctx ? await obtenerFoto(ctx.token, email).catch(() => null) : null;
    entrada = { foto, expira: Date.now() + TTL_FOTO_MS };
    if (cacheFotos.size >= MAX_FOTOS_CACHE) cacheFotos.delete(cacheFotos.keys().next().value);
    cacheFotos.set(email, entrada);
  }

  res.set('Cache-Control', 'private, max-age=3600');
  if (!entrada.foto) return res.status(404).end();
  res.type(entrada.foto.tipo).send(entrada.foto.datos);
}));

// ------------------------------------------------------------------
// Agenda de los asistentes: bloques ocupados del día y su estado en el horario propuesto
// ------------------------------------------------------------------
const PRIORIDAD = { free: 0, workingElsewhere: 1, tentative: 2, busy: 3, oof: 4 };

function parseFecha(v) {
  const d = typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

router.post('/agenda', noVisor, asyncH(async (req, res) => {
  const b = req.body || {};
  const desde = parseFecha(b.desde);
  const hasta = parseFecha(b.hasta);
  const inicio = parseFecha(b.inicio);
  const fin = parseFecha(b.fin);
  if (!desde || !hasta || hasta <= desde || hasta - desde > MAX_VENTANA_MS) throw new HttpError(400, 'Rango de agenda inválido');
  if (!inicio || !fin || fin <= inicio) throw new HttpError(400, 'Horario de la reunión inválido');

  if (!Array.isArray(b.emails)) throw new HttpError(400, 'Lista de correos inválida');
  const emails = [...new Set(b.emails.map((e) => String(e || '').trim().toLowerCase()))].filter((e) => EMAIL_RE.test(e));
  if (emails.length > MAX_AGENDAS) throw new HttpError(400, `Máximo ${MAX_AGENDAS} personas`);
  if (!emails.length) return res.json({ disponible: true, personas: [] });

  const ctx = await contextoLectura(req);
  if (!ctx?.base) return res.json({ disponible: null, personas: [], mensaje: 'La consulta de agendas no está disponible para esta cuenta.' });

  const agendas = await obtenerAgendas(ctx, emails, desde, hasta);
  const personas = agendas.map((a) => {
    if (a.error) {
      // Típico en correos externos o personas que no comparten su calendario
      return { email: a.scheduleId.toLowerCase(), estado: 'desconocido', error: 'Agenda no disponible', bloques: [] };
    }
    const bloques = (a.scheduleItems || [])
      .filter((i) => i.status !== 'free')
      .map((i) => ({
        inicio: new Date(`${i.start.dateTime.replace(/Z$/, '')}Z`),
        fin: new Date(`${i.end.dateTime.replace(/Z$/, '')}Z`),
        estado: i.status,
        // El asunto solo viene si la persona comparte detalles de su calendario
        asunto: i.isPrivate ? null : i.subject || null,
      }));
    const enReunion = bloques.filter((x) => x.inicio < fin && x.fin > inicio);
    const peor = enReunion.reduce((acc, x) => ((PRIORIDAD[x.estado] ?? 3) > (PRIORIDAD[acc] ?? 0) ? x.estado : acc), 'free');
    return { email: a.scheduleId.toLowerCase(), estado: peor, bloques };
  });

  res.json({
    disponible: personas.every((p) => p.estado === 'free' || p.estado === 'workingElsewhere'),
    personas,
  });
}));

module.exports = router;
