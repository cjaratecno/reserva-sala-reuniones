const express = require('express');
const config = require('../config');
const { obtenerConfigSso } = require('../sso-config');
const { query, conTransaccion } = require('../db');
const { HttpError, asyncH, noVisor } = require('../middleware');
const { obtenerTokenUsuario, obtenerTokenApp, SCOPE_MAIL } = require('../auth/msal');
const graph = require('../graph');
const { obtenerSala } = require('./salas');

const router = express.Router();

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const MAX_DURACION_MS = 12 * 60 * 60 * 1000;
const MAX_RANGO_CONSULTA_MS = 62 * 24 * 60 * 60 * 1000;
const MAX_ASISTENTES = 100;

function parseFecha(valor) {
  if (typeof valor !== 'string') return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validarReserva(body, emailOrganizador) {
  const b = body || {};
  const titulo = typeof b.titulo === 'string' ? b.titulo.trim() : '';
  if (!titulo || titulo.length > 255) throw new HttpError(400, 'El título es obligatorio (máx. 255 caracteres)');

  const descripcion = typeof b.descripcion === 'string' ? b.descripcion.trim() : '';
  if (descripcion.length > 4000) throw new HttpError(400, 'La descripción es demasiado larga (máx. 4000)');

  const inicio = parseFecha(b.inicio);
  const fin = parseFecha(b.fin);
  if (!inicio || !fin) throw new HttpError(400, 'Fecha u hora inválida');
  if (fin <= inicio) throw new HttpError(400, 'La hora de término debe ser posterior a la de inicio');
  if (fin - inicio > MAX_DURACION_MS) throw new HttpError(400, 'Una reserva no puede durar más de 12 horas');
  if (inicio.getTime() < Date.now() - 5 * 60 * 1000) throw new HttpError(400, 'No se puede reservar en el pasado');

  if (!Array.isArray(b.asistentes)) throw new HttpError(400, 'Lista de asistentes inválida');
  if (b.asistentes.length > MAX_ASISTENTES) throw new HttpError(400, `Máximo ${MAX_ASISTENTES} asistentes`);
  const vistos = new Set([emailOrganizador?.toLowerCase()]);
  const asistentes = [];
  for (const a of b.asistentes) {
    const email = typeof a?.email === 'string' ? a.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email) || email.length > 255) throw new HttpError(400, `Correo inválido: ${email || '(vacío)'}`);
    if (vistos.has(email)) continue; // el organizador ya queda incluido por ser quien agenda
    vistos.add(email);
    const nombre = typeof a.nombre === 'string' ? a.nombre.trim().slice(0, 200) : '';
    asistentes.push({ email, nombre: nombre || null });
  }

  return { titulo, descripcion, inicio, fin, asistentes, teams: b.teams === true };
}

/**
 * Reservas confirmadas de la sala que se cruzan con [inicio, fin).
 * Rangos semiabiertos: una reunión que termina 15:30 NO choca con otra que empieza 15:30.
 */
async function buscarConflictos(db, salaId, inicio, fin) {
  const { rows } = await db.query(
    `SELECT r.id, r.titulo, r.inicio, r.fin, u.nombre AS organizador
       FROM reservas r JOIN usuarios u ON u.id = r.organizador_id
      WHERE r.sala_id = $1 AND r.estado = 'confirmada'
        AND tstzrange(r.inicio, r.fin, '[)') && tstzrange($2, $3, '[)')
      ORDER BY r.inicio`,
    [salaId, inicio, fin]
  );
  return rows;
}

function mensajeConflicto(conflictos) {
  const hora = new Intl.DateTimeFormat('es-CL', {
    timeZone: config.zonaHoraria, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const detalle = conflictos
    .map((c) => `de ${hora.format(c.inicio)} a ${hora.format(c.fin)} («${c.titulo}», organiza ${c.organizador})`)
    .join('; ');
  return `La sala ya está reservada ${detalle}. Elija otro horario.`;
}

/** Desde qué buzón se crea el evento: el del usuario (delegado) o el buzón del admin (aplicación). */
async function contextoOrganizador(req) {
  const u = req.session.usuario;
  if (u.tipo === 'o365') {
    return { token: await obtenerTokenUsuario(req.session), base: '/me', email: u.email };
  }
  const cfg = await obtenerConfigSso();
  if (cfg.buzonAdmin) {
    return {
      token: await obtenerTokenApp(),
      base: `/users/${encodeURIComponent(cfg.buzonAdmin)}`,
      email: cfg.buzonAdmin,
    };
  }
  throw new HttpError(
    400,
    'Los administradores no pueden crear reservas: habilite los permisos de aplicación y el buzón organizador en Configuración'
  );
}

// ------------------------------------------------------------------
// Listado para el calendario
// ------------------------------------------------------------------
router.get('/', asyncH(async (req, res) => {
  const inicio = parseFecha(req.query.inicio);
  const fin = parseFecha(req.query.fin);
  if (!inicio || !fin || fin <= inicio) throw new HttpError(400, 'Rango de fechas inválido');
  if (fin - inicio > MAX_RANGO_CONSULTA_MS) throw new HttpError(400, 'Rango de fechas demasiado amplio');

  const { rows } = await query(
    `SELECT r.id, r.titulo, r.inicio, r.fin, s.nombre AS sala, s.color,
            u.nombre AS organizador, r.organizador_id, r.reunion_teams
       FROM reservas r
       JOIN salas s    ON s.id = r.sala_id
       JOIN usuarios u ON u.id = r.organizador_id
      WHERE r.estado = 'confirmada' AND r.inicio < $2 AND r.fin > $1
      ORDER BY r.inicio`,
    [inicio, fin]
  );
  const yo = req.session.usuario.id;
  res.json(rows.map(({ organizador_id, ...r }) => ({ ...r, propia: organizador_id === yo })));
}));

// ------------------------------------------------------------------
// Disponibilidad (validación en vivo del formulario)
// ------------------------------------------------------------------
router.get('/disponibilidad', asyncH(async (req, res) => {
  const inicio = parseFecha(req.query.inicio);
  const fin = parseFecha(req.query.fin);
  if (!inicio || !fin || fin <= inicio) throw new HttpError(400, 'Parámetros de disponibilidad inválidos');
  const sala = await obtenerSala();
  const conflictos = await buscarConflictos({ query }, sala.id, inicio, fin);
  res.json({
    disponible: conflictos.length === 0,
    conflictos: conflictos.map(({ id, titulo, inicio: i, fin: f, organizador }) => ({ id, titulo, inicio: i, fin: f, organizador })),
    mensaje: conflictos.length ? mensajeConflicto(conflictos) : null,
  });
}));

// ------------------------------------------------------------------
// Detalle
// ------------------------------------------------------------------
router.get('/:id', asyncH(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const { rows: [r] } = await query(
    `SELECT r.id, r.titulo, r.descripcion, r.inicio, r.fin, r.estado, r.reunion_teams, r.link_teams,
            r.sala_id, s.nombre AS sala, s.ubicacion, r.organizador_id, r.organizador_email,
            u.nombre AS organizador, r.creado_en
       FROM reservas r
       JOIN salas s    ON s.id = r.sala_id
       JOIN usuarios u ON u.id = r.organizador_id
      WHERE r.id = $1`,
    [id || 0]
  );
  if (!r) throw new HttpError(404, 'Reserva no encontrada');

  const { rows: asistentes } = await query(
    'SELECT email, nombre FROM reserva_asistentes WHERE reserva_id = $1 ORDER BY nombre NULLS LAST, email',
    [r.id]
  );
  const u = req.session.usuario;
  const { organizador_id, ...detalle } = r;
  res.json({
    ...detalle,
    asistentes,
    propia: organizador_id === u.id,
    puedeCancelar: r.estado === 'confirmada' && (organizador_id === u.id || u.tipo === 'admin'),
  });
}));

// ------------------------------------------------------------------
// Crear reserva + enviar invitaciones por Outlook
// ------------------------------------------------------------------
router.post('/', noVisor, asyncH(async (req, res) => {
  const ctx = await contextoOrganizador(req);
  const datos = validarReserva(req.body, ctx.email);

  const sala = await obtenerSala();
  if (!sala.activa) throw new HttpError(400, 'La sala no está habilitada para reservas en este momento');
  if (sala.capacidad && datos.asistentes.length + 1 > sala.capacidad) {
    throw new HttpError(400, `La sala tiene capacidad para ${sala.capacidad} personas`);
  }

  const reserva = await conTransaccion(async (client) => {
    // Revisión previa para dar un mensaje con detalle; el EXCLUDE constraint sigue siendo
    // la garantía final ante dos reservas simultáneas.
    const conflictos = await buscarConflictos(client, sala.id, datos.inicio, datos.fin);
    if (conflictos.length) throw new HttpError(409, mensajeConflicto(conflictos));

    let nueva;
    try {
      ({ rows: [nueva] } = await client.query(
        `INSERT INTO reservas (sala_id, organizador_id, organizador_email, titulo, descripcion, inicio, fin, reunion_teams)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, sala_id, titulo, inicio, fin, estado`,
        [sala.id, req.session.usuario.id, ctx.email, datos.titulo, datos.descripcion || null,
          datos.inicio, datos.fin, datos.teams]
      ));
    } catch (err) {
      // 23P01 = exclusion_violation: la sala ya está ocupada en ese horario
      if (err.code === '23P01') {
        throw new HttpError(409, 'Otra persona acaba de reservar la sala en ese horario. Elija otro horario.');
      }
      throw err;
    }

    for (const a of datos.asistentes) {
      await client.query(
        'INSERT INTO reserva_asistentes (reserva_id, email, nombre) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [nueva.id, a.email, a.nombre]
      );
    }

    // Si Graph falla se hace ROLLBACK y la sala queda libre
    const evento = await graph.crearEvento(ctx, { ...datos, sala, reservaId: nueva.id });
    const linkTeams = evento.onlineMeeting?.joinUrl || null;
    await client.query(
      'UPDATE reservas SET graph_event_id = $1, link_teams = $2, actualizado_en = now() WHERE id = $3',
      [evento.id, linkTeams, nueva.id]
    );
    return { ...nueva, link_teams: linkTeams, invitados: datos.asistentes.length };
  });

  // Confirmación por correo a quien reserva (la reserva ya quedó hecha; un fallo aquí solo genera un aviso)
  const cfg = await obtenerConfigSso();
  if (cfg.enviarConfirmacion && ctx.base === '/me') {
    try {
      const tokenMail = await obtenerTokenUsuario(req.session, SCOPE_MAIL);
      await graph.enviarConfirmacion(tokenMail, {
        para: ctx.email,
        titulo: datos.titulo,
        descripcion: datos.descripcion,
        inicio: datos.inicio,
        fin: datos.fin,
        sala,
        asistentes: datos.asistentes,
        linkTeams: reserva.link_teams,
        zonaHoraria: config.zonaHoraria,
      });
      reserva.confirmacionEnviada = true;
    } catch (err) {
      console.warn(`No se pudo enviar la confirmación de la reserva #${reserva.id}:`, err.message.slice(0, 300));
      reserva.aviso =
        'La reserva quedó confirmada y se invitó a los asistentes, pero no se pudo enviarle el correo de confirmación ' +
        '(revise que la aplicación tenga el permiso Mail.Send y vuelva a iniciar sesión).';
    }
  }

  res.status(201).json(reserva);
}));

// ------------------------------------------------------------------
// Cancelar: SOLO quien creó la reserva o un administrador completo.
// Recepción (visor) y los demás usuarios no pueden. Envía la cancelación por Outlook.
// ------------------------------------------------------------------
router.delete('/:id', noVisor, asyncH(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10) || 0;
  const u = req.session.usuario;
  const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim().slice(0, 1000) : '';

  const aviso = await conTransaccion(async (client) => {
    const { rows: [r] } = await client.query(
      `SELECT id, organizador_id, organizador_email, graph_event_id, estado FROM reservas WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!r || r.estado !== 'confirmada') throw new HttpError(404, 'Reserva no encontrada o ya cancelada');
    const esOrganizador = r.organizador_id === u.id;
    if (!esOrganizador && u.tipo !== 'admin') {
      throw new HttpError(403, 'Solo quien creó la reserva o un administrador puede cancelarla');
    }

    let avisoCancelacion = null;
    if (r.graph_event_id) {
      let ctx = null;
      if (esOrganizador && u.tipo === 'o365') {
        ctx = { token: await obtenerTokenUsuario(req.session), base: '/me' };
      } else if ((await obtenerConfigSso()).appHabilitada) {
        ctx = { token: await obtenerTokenApp(), base: `/users/${encodeURIComponent(r.organizador_email)}` };
      } else {
        avisoCancelacion =
          'La sala fue liberada, pero no se pudo enviar la cancelación a los invitados (faltan permisos de aplicación en Graph). ' +
          'El organizador debe cancelar la reunión en Outlook.';
      }
      if (ctx) {
        try {
          await graph.cancelarEvento(ctx, r.graph_event_id, motivo);
        } catch (err) {
          if (err.graphStatus !== 404) throw err;
          avisoCancelacion = 'El evento ya no existía en Outlook; se liberó la sala.';
        }
      }
    }

    await client.query(
      `UPDATE reservas SET estado = 'cancelada', cancelada_por = $1, motivo_cancelacion = $2, actualizado_en = now()
        WHERE id = $3`,
      [u.id, motivo || null, r.id]
    );
    return avisoCancelacion;
  });

  res.json({ ok: true, aviso });
}));

module.exports = router;
