// El sistema administra UNA sola sala de reuniones (la primera fila de la tabla salas).
const express = require('express');
const { query } = require('../db');
const { HttpError, asyncH, requiereAdmin } = require('../middleware');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Devuelve la sala de reuniones (db puede ser un client de transacción). */
async function obtenerSala(db = { query }) {
  const { rows: [sala] } = await db.query(
    'SELECT id, nombre, ubicacion, capacidad, email_recurso, color, activa FROM salas ORDER BY id LIMIT 1'
  );
  if (!sala) throw new HttpError(500, 'No hay una sala configurada');
  return sala;
}

function validarSala(b = {}) {
  const nombre = typeof b.nombre === 'string' ? b.nombre.trim() : '';
  if (!nombre || nombre.length > 100) throw new HttpError(400, 'El nombre es obligatorio (máx. 100 caracteres)');
  const ubicacion = typeof b.ubicacion === 'string' ? b.ubicacion.trim().slice(0, 200) || null : null;
  const capacidad = b.capacidad === '' || b.capacidad == null ? null : Number.parseInt(b.capacidad, 10);
  if (capacidad !== null && !(capacidad > 0)) throw new HttpError(400, 'Capacidad inválida');
  const emailRecurso = typeof b.email_recurso === 'string' ? b.email_recurso.trim().toLowerCase() || null : null;
  if (emailRecurso && !EMAIL_RE.test(emailRecurso)) throw new HttpError(400, 'Correo del recurso inválido');
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#2563eb';
  return [nombre, ubicacion, capacidad, emailRecurso, color, b.activa !== false];
}

router.get('/', asyncH(async (req, res) => {
  res.json(await obtenerSala());
}));

router.put('/', requiereAdmin, asyncH(async (req, res) => {
  const { id } = await obtenerSala();
  const { rows: [sala] } = await query(
    `UPDATE salas SET nombre = $1, ubicacion = $2, capacidad = $3, email_recurso = $4, color = $5, activa = $6
      WHERE id = $7 RETURNING id, nombre, ubicacion, capacidad, email_recurso, color, activa`,
    [...validarSala(req.body), id]
  );
  res.json(sala);
}));

module.exports = { router, obtenerSala };
