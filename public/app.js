'use strict';

const $ = (sel) => document.querySelector(sel);
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

let yo = null;
let sala = null; // la única sala de reuniones
let calendario = null;
let invitados = []; // [{ email, nombre }]

// ------------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------------
async function api(url, opciones = {}) {
  const res = await fetch(url, {
    method: opciones.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Sesión expirada');
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

function esc(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

let toastTimer;
function toast(mensaje, error = false) {
  const el = $('#toast');
  el.textContent = mensaje;
  el.className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), error ? 6000 : 3500);
}

const pad = (n) => String(n).padStart(2, '0');
const fechaLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const horaLocal = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtFecha = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtHora = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });

// --- Avatares: foto de Microsoft 365 si existe; si no, iniciales sobre un color estable ---
function iniciales(nombre, email) {
  const base = (nombre || (email || '').split('@')[0]).replace(/[._-]+/g, ' ').trim();
  const partes = base.split(/\s+/).filter(Boolean);
  const ini = (partes[0]?.[0] || '') + (partes.length > 1 ? partes[partes.length - 1][0] : '');
  return ini.toUpperCase() || '?';
}

function colorAvatar(texto) {
  let h = 0;
  for (const c of String(texto)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 38%)`;
}

function avatar(email, nombre, clase = '') {
  const img = yo?.puedeVerFotos && email
    ? `<img src="/api/directorio/foto?email=${encodeURIComponent(email)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  return `<span class="avatar ${clase}" style="background:${colorAvatar(email || nombre)}" aria-hidden="true"><span>${esc(iniciales(nombre, email))}</span>${img}</span>`;
}

document.querySelectorAll('[data-cerrar]').forEach((b) =>
  b.addEventListener('click', () => b.closest('dialog').close())
);

// ------------------------------------------------------------------
// Inicio
// ------------------------------------------------------------------
async function iniciar() {
  yo = await api('/api/me');
  $('#userName').textContent = yo.nombre;
  if (yo.tipo === 'o365') $('#userName').insertAdjacentHTML('beforebegin', avatar(yo.email, yo.nombre, 'avatar-sm'));
  const rol = $('#userRol');
  rol.textContent = { admin: 'Administrador', visor: 'Solo visualización', o365: 'Microsoft 365' }[yo.tipo] || '';
  if (yo.tipo === 'visor') rol.classList.add('visor');
  if (yo.tipo === 'admin') {
    rol.classList.add('admin');
    $('#btnSala').hidden = false;
    $('#btnConfig').hidden = false;
    revisarAvisosAdmin();
  }

  await cargarSala();
  iniciarCalendario();
}

const puedeReservarAhora = () => yo.puedeReservar && sala?.activa;

async function cargarSala() {
  sala = await api('/api/sala');
  $('#fichaSala').innerHTML = `
    <div class="ficha-sala-nombre"><i style="background:${esc(sala.color)}"></i>${esc(sala.nombre)}</div>
    ${sala.ubicacion ? `<div class="ficha-sala-dato">${esc(sala.ubicacion)}</div>` : ''}
    ${sala.activa ? '' : '<div class="ficha-sala-estado">Fuera de servicio: no se aceptan nuevas reservas</div>'}`;

  $('#btnNueva').hidden = !puedeReservarAhora();
  $('#hint').textContent = yo.soloLectura
    ? 'Modo solo visualización: puede ver las reservas de la sala, pero no crearlas ni cancelarlas. Haga clic en una reserva para ver el detalle.'
    : !yo.puedeReservar
    ? 'Como administrador puede ver y cancelar reservas. Para crear reservas habilite un buzón organizador en Configuración.'
    : !sala.activa
      ? 'La sala no está habilitada para reservas en este momento.'
      : 'Arrastre sobre el calendario para seleccionar un horario, o haga clic en una reserva para ver el detalle.';
  calendario?.setOption('selectable', puedeReservarAhora());
}

function iniciarCalendario() {
  const movil = window.innerWidth < 760;
  calendario = new FullCalendar.Calendar($('#calendario'), {
    locale: 'es',
    initialView: movil ? 'timeGridDay' : 'timeGridWeek',
    headerToolbar: movil
      ? { left: 'prev,next today', center: 'title', right: 'timeGridDay,listWeek' }
      : { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' },
    slotMinTime: '07:00:00',
    slotMaxTime: '21:00:00',
    slotDuration: '00:30:00',
    snapDuration: '00:15:00',
    allDaySlot: false,
    nowIndicator: true,
    height: 'auto',
    selectable: puedeReservarAhora(),
    selectMirror: true,
    selectAllow: (info) => info.start >= new Date(Date.now() - 5 * 60 * 1000),
    selectOverlap: false, // no se puede seleccionar encima de una reserva existente
    events: (info, ok, falla) => {
      const url = `/api/reservas?inicio=${encodeURIComponent(info.startStr)}&fin=${encodeURIComponent(info.endStr)}`;
      api(url)
        .then((rows) =>
          ok(rows.map((r) => ({
            id: String(r.id),
            title: r.titulo,
            start: r.inicio,
            end: r.fin,
            backgroundColor: r.color,
            borderColor: r.propia ? '#f0b429' : r.color, // las reservas propias se marcan en dorado
            extendedProps: r,
          })))
        )
        .catch((err) => {
          toast(err.message, true);
          falla(err);
        });
    },
    eventDidMount: (info) => {
      info.el.title = `${info.event.extendedProps.titulo}\nOrganiza: ${info.event.extendedProps.organizador}`;
    },
    select: (info) => {
      calendario.unselect();
      abrirNuevaReserva(info.start, info.end);
    },
    dateClick: (info) => {
      if (!puedeReservarAhora() || info.view.type !== 'dayGridMonth') return;
      const inicio = new Date(info.date);
      inicio.setHours(9, 0, 0, 0);
      abrirNuevaReserva(inicio, new Date(inicio.getTime() + 60 * 60 * 1000));
    },
    eventClick: (info) => abrirDetalle(info.event.id),
  });
  calendario.render();
}

// ------------------------------------------------------------------
// Nueva reserva
// ------------------------------------------------------------------
function abrirNuevaReserva(inicio, fin) {
  if (!puedeReservarAhora()) return toast('La sala no está habilitada para reservas en este momento', true);
  const form = $('#formReserva');
  form.reset();
  invitados = [];
  pintarInvitados();

  if (!inicio) {
    inicio = new Date();
    inicio.setMinutes(Math.ceil(inicio.getMinutes() / 15) * 15, 0, 0);
    fin = new Date(inicio.getTime() + 60 * 60 * 1000);
  }
  form.fecha.value = fechaLocal(inicio);
  form.desde.value = horaLocal(inicio);
  form.hasta.value = horaLocal(fin);

  $('#dlgReserva').showModal();
  form.titulo.focus();
  verificarDisponibilidad();
}

$('#btnNueva').addEventListener('click', () => abrirNuevaReserva());

// --- Validación en vivo de que la sala esté libre en ese horario ---
let salaDisponible = true;
let consultaDisponibilidad = 0;
let disponibilidadTimer;

function rangoFormulario() {
  const f = $('#formReserva');
  if (!f.fecha.value || !f.desde.value || !f.hasta.value) return null;
  return { inicio: new Date(`${f.fecha.value}T${f.desde.value}`), fin: new Date(`${f.fecha.value}T${f.hasta.value}`) };
}

function pintarDisponibilidad(clase, html) {
  const caja = $('#disponibilidad');
  caja.className = `disponibilidad ${clase}`;
  caja.innerHTML = `<div>${html}</div>`;
  caja.hidden = false;
  $('#btnGuardar').disabled = clase !== 'libre';
}

async function verificarDisponibilidad() {
  const rango = rangoFormulario();
  const id = ++consultaDisponibilidad; // descarta respuestas de consultas anteriores
  salaDisponible = false;

  if (!rango) {
    $('#disponibilidad').hidden = true;
    return;
  }
  if (rango.fin <= rango.inicio) {
    return pintarDisponibilidad('ocupada', 'La hora de término debe ser posterior a la de inicio.');
  }
  if (rango.inicio < new Date(Date.now() - 5 * 60 * 1000)) {
    return pintarDisponibilidad('ocupada', 'No se puede reservar en un horario que ya pasó.');
  }

  pintarDisponibilidad('revisando', 'Revisando disponibilidad de la sala…');
  try {
    const params = new URLSearchParams({ inicio: rango.inicio.toISOString(), fin: rango.fin.toISOString() });
    const r = await api(`/api/reservas/disponibilidad?${params}`);
    if (id !== consultaDisponibilidad) return;
    salaDisponible = r.disponible;
    const nombre = sala?.nombre || 'La sala';
    if (r.disponible) {
      pintarDisponibilidad('libre', `<b>${esc(nombre)}</b> está disponible de ${fmtHora.format(rango.inicio)} a ${fmtHora.format(rango.fin)}.`);
    } else {
      const lista = r.conflictos
        .map((c) => `<li>${fmtHora.format(new Date(c.inicio))} – ${fmtHora.format(new Date(c.fin))}: «${esc(c.titulo)}» (organiza ${esc(c.organizador)})</li>`)
        .join('');
      pintarDisponibilidad('ocupada', `<b>${esc(nombre)}</b> ya está reservada en ese horario:<ul>${lista}</ul>Elija otro horario.`);
    }
  } catch (err) {
    if (id !== consultaDisponibilidad) return;
    // Si falla la consulta no se bloquea: el servidor valida igual al guardar
    salaDisponible = true;
    $('#disponibilidad').hidden = true;
    $('#btnGuardar').disabled = false;
  }
}

['fecha', 'desde', 'hasta'].forEach((campo) => {
  const el = $('#formReserva').elements[campo];
  const programar = () => {
    clearTimeout(disponibilidadTimer);
    disponibilidadTimer = setTimeout(verificarDisponibilidad, 250);
    programarAgenda();
  };
  el.addEventListener('input', programar);
  el.addEventListener('change', programar);
});

function agregarInvitado(email, nombre) {
  email = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return toast('Correo inválido', true);
  if (email === yo.email?.toLowerCase()) return toast('Usted ya está incluido como organizador');
  if (!invitados.some((i) => i.email === email)) invitados.push({ email, nombre: nombre || null });
  pintarInvitados();
  $('#buscarPersona').value = '';
  ocultarResultados();
}

function pintarInvitados(refrescarAgenda = true) {
  $('#chips').innerHTML = invitados.length
    ? invitados
      .map((i, idx) => {
        const est = ESTADOS_AGENDA[estadosAgenda[i.email]];
        const punto = est ? `<i class="punto ${est.clase}" title="${esc(est.texto)}"></i>` : '';
        return `<span class="chip" title="${esc(i.email)}${est ? ` · ${esc(est.texto)}` : ''}">${avatar(i.email, i.nombre, 'avatar-xs')}${esc(i.nombre || i.email)}${punto}<button type="button" data-quitar="${idx}" aria-label="Quitar">×</button></span>`;
      })
      .join('')
    : '<span class="hint">Aún no hay invitados.</span>';
  if (refrescarAgenda) programarAgenda();
}

$('#chips').addEventListener('click', (e) => {
  const idx = e.target.closest('[data-quitar]')?.dataset.quitar;
  if (idx !== undefined) {
    invitados.splice(Number(idx), 1);
    pintarInvitados();
  }
});

// ------------------------------------------------------------------
// Agenda de los asistentes (disponibilidad en Outlook)
// ------------------------------------------------------------------
const ESTADOS_AGENDA = {
  free: { texto: 'Disponible', clase: 'libre' },
  workingElsewhere: { texto: 'Disponible (trabaja en otro lugar)', clase: 'libre' },
  tentative: { texto: 'Tentativo', clase: 'tentativo' },
  busy: { texto: 'Ocupado', clase: 'ocupado' },
  oof: { texto: 'Fuera de la oficina', clase: 'fuera' },
  desconocido: { texto: 'Agenda no disponible', clase: 'desconocido' },
};
const AGENDA_DESDE_H = 7;
const AGENDA_HASTA_H = 21;
let estadosAgenda = {}; // email -> estado en el horario propuesto
let consultaAgenda = 0;
let agendaTimer;
let ventanaAgenda = null;

function programarAgenda() {
  clearTimeout(agendaTimer);
  agendaTimer = setTimeout(actualizarAgenda, 400);
}

async function actualizarAgenda() {
  const caja = $('#agenda');
  const rango = rangoFormulario();
  const id = ++consultaAgenda;
  if (!yo.puedeVerAgendas || !invitados.length || !rango || rango.fin <= rango.inicio) {
    caja.hidden = true;
    if (Object.keys(estadosAgenda).length) {
      estadosAgenda = {};
      pintarInvitados(false);
    }
    return;
  }

  // Día completo (07:00–21:00), ampliado si la reunión queda fuera de ese rango
  const desde = new Date(rango.inicio);
  desde.setHours(Math.min(AGENDA_DESDE_H, rango.inicio.getHours()), 0, 0, 0);
  const hasta = new Date(rango.inicio);
  hasta.setHours(AGENDA_HASTA_H, 0, 0, 0);
  if (rango.fin > hasta) hasta.setTime(Math.min(rango.fin.getTime() + 60 * 60 * 1000, desde.getTime() + 24 * 60 * 60 * 1000));

  const personas = [
    ...(yo.tipo === 'o365' && yo.email ? [{ email: yo.email.toLowerCase(), nombre: yo.nombre, esYo: true }] : []),
    ...invitados,
  ];

  if (caja.hidden) {
    caja.hidden = false;
    caja.innerHTML = '<p class="hint agenda-cargando">Consultando la agenda de los asistentes…</p>';
  } else {
    caja.classList.add('actualizando');
  }

  let r;
  try {
    r = await api('/api/directorio/agenda', {
      method: 'POST',
      body: {
        emails: personas.map((p) => p.email),
        desde: desde.toISOString(),
        hasta: hasta.toISOString(),
        inicio: rango.inicio.toISOString(),
        fin: rango.fin.toISOString(),
      },
    });
  } catch (err) {
    if (id !== consultaAgenda) return;
    caja.classList.remove('actualizando');
    caja.innerHTML = `<p class="hint">No se pudo consultar la agenda de los asistentes (${esc(err.message)}).</p>`;
    return;
  }
  if (id !== consultaAgenda) return;
  caja.classList.remove('actualizando');
  if (r.disponible === null) {
    caja.hidden = true;
    return;
  }

  const porEmail = Object.fromEntries(r.personas.map((p) => [p.email, p]));
  estadosAgenda = Object.fromEntries(r.personas.map((p) => [p.email, p.estado]));
  ventanaAgenda = { desde, hasta };
  pintarAgenda(personas, porEmail, rango, desde, hasta);
  pintarInvitados(false);
}

function pintarAgenda(personas, porEmail, rango, desde, hasta) {
  const total = hasta - desde;
  const pct = (t) => Math.max(0, Math.min(100, ((new Date(t) - desde) / total) * 100));
  const tramo = (a, b) => `left:${pct(a)}%;width:${Math.max(0.6, pct(b) - pct(a))}%`;

  // Eje de horas
  const horas = [];
  const h = new Date(desde);
  h.setMinutes(0, 0, 0);
  if (h < desde) h.setHours(h.getHours() + 1);
  for (; h <= hasta; h.setHours(h.getHours() + 1)) {
    horas.push(`<span style="left:${pct(h)}%">${pad(h.getHours())}</span>`);
  }

  const conConflicto = personas.filter((p) => ['busy', 'oof', 'tentative'].includes(porEmail[p.email]?.estado));
  const sinDatos = personas.filter((p) => porEmail[p.email]?.estado === 'desconocido');
  const resumen = conConflicto.length
    ? `<div class="disponibilidad ocupada"><div><b>${conConflicto.length} persona(s) con otra actividad en ese horario:</b> ${conConflicto.map((p) => esc(p.esYo ? 'usted' : p.nombre || p.email)).join(', ')}.</div></div>`
    : `<div class="disponibilidad libre"><div>Todos los asistentes${sinDatos.length ? ' con agenda visible' : ''} están disponibles de ${fmtHora.format(rango.inicio)} a ${fmtHora.format(rango.fin)}.</div></div>`;

  const filas = personas
    .map((p) => {
      const datos = porEmail[p.email] || { estado: 'desconocido', bloques: [] };
      const est = ESTADOS_AGENDA[datos.estado] || ESTADOS_AGENDA.desconocido;
      const bloques = datos.bloques
        .map((b) => {
          const e = ESTADOS_AGENDA[b.estado] || ESTADOS_AGENDA.busy;
          const titulo = `${fmtHora.format(new Date(b.inicio))}–${fmtHora.format(new Date(b.fin))} · ${e.texto}${b.asunto ? ` · ${b.asunto}` : ''}`;
          return `<span class="agenda-bloque ${e.clase}" style="${tramo(b.inicio, b.fin)}" title="${esc(titulo)}"></span>`;
        })
        .join('');
      return `<div class="agenda-fila">
        <div class="agenda-persona">${avatar(p.email, p.nombre, 'avatar-sm')}
          <div><b>${esc(p.esYo ? `${p.nombre} (usted)` : p.nombre || p.email)}</b><small class="estado-${est.clase}">${esc(est.texto)}</small></div>
        </div>
        <div class="agenda-pista" title="Haga clic para mover la reunión a esa hora">
          ${datos.estado === 'desconocido' ? '<span class="agenda-sin-datos">Sin acceso a su agenda</span>' : bloques}
          <span class="agenda-reunion" style="${tramo(rango.inicio, rango.fin)}"></span>
        </div>
      </div>`;
    })
    .join('');

  $('#agenda').innerHTML = `
    <div class="agenda-titulo">Agenda de los asistentes · ${esc(fmtFecha.format(rango.inicio))}</div>
    ${resumen}
    <div class="agenda-grilla" style="--horas:${total / 3600000}">
      <div class="agenda-fila agenda-eje"><div></div><div class="agenda-horas">${horas.join('')}</div></div>
      ${filas}
    </div>
    <div class="agenda-leyenda">
      <span><i class="punto ocupado"></i>Ocupado</span><span><i class="punto tentativo"></i>Tentativo</span>
      <span><i class="punto fuera"></i>Fuera de la oficina</span><span><i class="leyenda-reunion"></i>Horario propuesto</span>
      <span class="hint">Clic en la línea de tiempo para mover la reunión.</span>
    </div>`;
}

// Clic en la línea de tiempo: mueve la reunión a esa hora (redondeado a 15 min), manteniendo la duración
$('#agenda').addEventListener('click', (e) => {
  const pista = e.target.closest('.agenda-pista');
  const rango = rangoFormulario();
  if (!pista || !ventanaAgenda || !rango) return;
  const caja = pista.getBoundingClientRect();
  const fraccion = Math.min(1, Math.max(0, (e.clientX - caja.left) / caja.width));
  const t = ventanaAgenda.desde.getTime() + fraccion * (ventanaAgenda.hasta - ventanaAgenda.desde);
  const inicio = new Date(Math.round(t / (15 * 60 * 1000)) * 15 * 60 * 1000);
  const fin = new Date(inicio.getTime() + (rango.fin - rango.inicio));
  if (fechaLocal(fin) !== fechaLocal(inicio)) return toast('La reunión debe terminar el mismo día', true);
  const f = $('#formReserva');
  f.desde.value = horaLocal(inicio);
  f.hasta.value = horaLocal(fin);
  f.desde.dispatchEvent(new Event('change'));
});

// Búsqueda en el directorio de Microsoft 365
let busquedaTimer;
let resultadosActuales = [];
let indiceActivo = -1;

function ocultarResultados() {
  $('#resultados').hidden = true;
  resultadosActuales = [];
  indiceActivo = -1;
}

function pintarResultados() {
  const ul = $('#resultados');
  if (!resultadosActuales.length) return ocultarResultados();
  ul.innerHTML = resultadosActuales
    .map((p, i) => `<li data-idx="${i}" class="${i === indiceActivo ? 'activo' : ''}">${avatar(p.email, p.nombre)}<div>${esc(p.nombre)}<small>${esc(p.email)}${p.cargo ? ` · ${esc(p.cargo)}` : ''}</small></div></li>`)
    .join('');
  ul.hidden = false;
}

$('#buscarPersona').addEventListener('input', (e) => {
  clearTimeout(busquedaTimer);
  const texto = e.target.value.trim();
  if (texto.length < 2 || !yo.puedeBuscarPersonas) return ocultarResultados();
  busquedaTimer = setTimeout(async () => {
    try {
      resultadosActuales = await api(`/api/directorio?q=${encodeURIComponent(texto)}`);
      indiceActivo = resultadosActuales.length ? 0 : -1;
      pintarResultados();
    } catch (err) {
      toast(err.message, true);
    }
  }, 250);
});

$('#buscarPersona').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!resultadosActuales.length) return;
    e.preventDefault();
    const n = resultadosActuales.length;
    indiceActivo = (indiceActivo + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    pintarResultados();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const elegido = resultadosActuales[indiceActivo];
    if (elegido) agregarInvitado(elegido.email, elegido.nombre);
    else if (e.target.value.trim()) agregarInvitado(e.target.value);
  } else if (e.key === 'Escape' && !$('#resultados').hidden) {
    e.preventDefault();
    ocultarResultados();
  }
});

$('#resultados').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  const p = resultadosActuales[Number(li.dataset.idx)];
  agregarInvitado(p.email, p.nombre);
});
$('#buscarPersona').addEventListener('blur', () => setTimeout(ocultarResultados, 150));
$('#btnAgregarCorreo').addEventListener('click', () => agregarInvitado($('#buscarPersona').value));

$('#formReserva').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.titulo.value.trim()) return toast('Ingrese el asunto de la reunión', true);
  if (!f.fecha.value || !f.desde.value || !f.hasta.value) return toast('Complete fecha y horario', true);

  const inicio = new Date(`${f.fecha.value}T${f.desde.value}`);
  const fin = new Date(`${f.fecha.value}T${f.hasta.value}`);
  if (fin <= inicio) return toast('La hora de término debe ser posterior a la de inicio', true);
  if (!salaDisponible) return toast('La sala no está disponible en ese horario. Elija otro horario.', true);

  // Si quedó un correo escrito sin agregar, se agrega automáticamente
  const pendiente = $('#buscarPersona').value.trim();
  if (pendiente && EMAIL_RE.test(pendiente)) agregarInvitado(pendiente);

  const boton = $('#btnGuardar');
  boton.disabled = true;
  boton.textContent = 'Enviando invitaciones…';
  try {
    const r = await api('/api/reservas', {
      method: 'POST',
      body: {
        titulo: f.titulo.value,
        inicio: inicio.toISOString(),
        fin: fin.toISOString(),
        descripcion: f.descripcion.value,
        teams: f.teams.checked,
        asistentes: invitados,
      },
    });
    $('#dlgReserva').close();
    calendario.refetchEvents();
    if (r.aviso) toast(r.aviso, true);
    else toast(`Reserva confirmada. Invitación enviada a ${r.invitados} invitado(s)${r.confirmacionEnviada ? ' y confirmación a su correo' : ''}.`);
  } catch (err) {
    toast(err.message, true);
    calendario.refetchEvents();
  } finally {
    boton.disabled = false;
    boton.textContent = 'Reservar y enviar invitaciones';
    if ($('#dlgReserva').open) verificarDisponibilidad(); // p. ej. si otra persona reservó justo antes
  }
});

// ------------------------------------------------------------------
// Detalle / cancelación
// ------------------------------------------------------------------
let reservaAbierta = null;

async function abrirDetalle(id) {
  try {
    const r = await api(`/api/reservas/${id}`);
    reservaAbierta = r;
    const inicio = new Date(r.inicio);
    const fin = new Date(r.fin);
    $('#detTitulo').textContent = r.titulo;
    $('#detCuerpo').innerHTML = `
      <dt>Cuándo</dt><dd>${esc(fmtFecha.format(inicio))}, ${fmtHora.format(inicio)} – ${fmtHora.format(fin)}</dd>
      <dt>Sala</dt><dd>${esc(r.sala)}${r.ubicacion ? ` · ${esc(r.ubicacion)}` : ''}</dd>
      <dt>Organiza</dt><dd><ul class="personas"><li>${avatar(r.organizador_email, r.organizador, 'avatar-sm')}<div>${esc(r.organizador)}<small>${esc(r.organizador_email)}</small></div></li></ul></dd>
      <dt>Invitados (${r.asistentes.length})</dt>
      <dd>${r.asistentes.length
        ? `<ul class="personas">${r.asistentes.map((a) => `<li>${avatar(a.email, a.nombre, 'avatar-sm')}<div>${esc(a.nombre || a.email)}${a.nombre ? `<small>${esc(a.email)}</small>` : ''}</div></li>`).join('')}</ul>`
        : '<span class="muted">Sin invitados</span>'}</dd>
      ${r.descripcion ? `<dt>Descripción</dt><dd>${esc(r.descripcion)}</dd>` : ''}
      ${r.link_teams ? `<dt>Microsoft Teams</dt><dd><a href="${esc(r.link_teams)}" target="_blank" rel="noopener">Unirse a la reunión</a></dd>` : ''}`;
    $('#btnCancelarReserva').hidden = !r.puedeCancelar;
    $('#dlgDetalle').showModal();
  } catch (err) {
    toast(err.message, true);
  }
}

$('#btnCancelarReserva').addEventListener('click', () => {
  if (!reservaAbierta) return;
  const r = reservaAbierta;
  const inicio = new Date(r.inicio);
  $('#formCancelar').reset();
  $('#cancelarTitulo').textContent = r.titulo;
  $('#cancelarDetalle').textContent =
    `${fmtFecha.format(inicio)}, ${fmtHora.format(inicio)} – ${fmtHora.format(new Date(r.fin))} · ${r.sala}` +
    (r.asistentes.length ? ` · ${r.asistentes.length} invitado(s)` : '');
  $('#dlgCancelar').showModal();
  $('#formCancelar').motivo.focus();
});

$('#formCancelar').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!reservaAbierta) return;
  const boton = $('#btnConfirmarCancelar');
  boton.disabled = true;
  boton.textContent = 'Cancelando…';
  try {
    const r = await api(`/api/reservas/${reservaAbierta.id}`, { method: 'DELETE', body: { motivo: e.target.motivo.value } });
    $('#dlgCancelar').close();
    $('#dlgDetalle').close();
    calendario.refetchEvents();
    toast(r.aviso || 'Reserva cancelada y aviso enviado a los invitados.', Boolean(r.aviso));
  } catch (err) {
    toast(err.message, true);
  } finally {
    boton.disabled = false;
    boton.textContent = 'Sí, cancelar reserva';
  }
});

// ------------------------------------------------------------------
// Datos de la sala (solo admin)
// ------------------------------------------------------------------
$('#btnSala').addEventListener('click', () => {
  const f = $('#formSala');
  f.nombre.value = sala.nombre;
  f.ubicacion.value = sala.ubicacion || '';
  f.capacidad.value = sala.capacidad ?? '';
  f.color.value = sala.color;
  f.email_recurso.value = sala.email_recurso || '';
  f.activa.checked = sala.activa;
  $('#dlgSala').showModal();
});

$('#formSala').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.nombre.value.trim()) return toast('Ingrese el nombre de la sala', true);
  const datos = {
    nombre: f.nombre.value,
    ubicacion: f.ubicacion.value,
    capacidad: f.capacidad.value,
    color: f.color.value,
    email_recurso: f.email_recurso.value,
    activa: f.activa.checked,
  };
  conBoton(e.submitter || f.querySelector('button[type=submit]'), 'Guardando…', async () => {
    await api('/api/sala', { method: 'PUT', body: datos });
    await cargarSala();
    calendario.refetchEvents();
    $('#dlgSala').close();
    toast('Datos de la sala guardados');
  });
});

// ------------------------------------------------------------------
// Configuración (solo admin): SSO, administradores, contraseña propia
// ------------------------------------------------------------------
const DIAS_AVISO_SECRETO = 30;

function diasHasta(fechaIso) {
  if (!fechaIso) return null;
  const [a, m, d] = fechaIso.split('-').map(Number);
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  return Math.round((new Date(a, m - 1, d) - hoy) / 86400000);
}

/** Devuelve [claseCss, mensaje] con el estado del SSO. */
function estadoSso(cfg) {
  if (cfg.secretoIlegible) return ['error', 'No se puede leer el secreto guardado (cambió la clave de cifrado del servidor). Vuelva a ingresarlo.'];
  if (!cfg.habilitado) return ['alerta-amarilla', 'El inicio de sesión con Microsoft 365 aún no está configurado. Solo pueden entrar administradores.'];
  const dias = diasHasta(cfg.secretoVence);
  if (dias !== null && dias < 0) return ['error', `El secreto de cliente venció hace ${-dias} día(s): los usuarios no pueden iniciar sesión. Genere uno nuevo en Azure e ingréselo aquí.`];
  if (dias !== null && dias <= DIAS_AVISO_SECRETO) return ['alerta-amarilla', `El secreto de cliente vence en ${dias} día(s). Genere uno nuevo en Azure y actualícelo aquí antes de esa fecha.`];
  return ['ok', `Microsoft 365 configurado${cfg.secretoVence ? `. El secreto vence en ${dias} día(s)` : ''}.`];
}

async function revisarAvisosAdmin() {
  try {
    const cfg = await api('/api/admin/sso');
    const [clase, mensaje] = estadoSso(cfg);
    const aviso = $('#avisoAdmin');
    aviso.hidden = clase === 'ok';
    aviso.className = clase === 'error' ? 'aviso error' : 'aviso';
    aviso.innerHTML = `${esc(mensaje)} <button type="button" class="btn-sec" id="btnAvisoConfig">Ir a configuración</button>`;
    $('#btnAvisoConfig').addEventListener('click', () => abrirConfig('tabSso'));
  } catch {
    /* no bloquear la app por el aviso */
  }
}

function mostrarTab(id) {
  document.querySelectorAll('#dlgConfig .tab').forEach((t) => t.classList.toggle('activa', t.dataset.tab === id));
  document.querySelectorAll('#dlgConfig .tab-panel').forEach((p) => (p.hidden = p.id !== id));
}
document.querySelectorAll('#dlgConfig .tab').forEach((t) => t.addEventListener('click', () => mostrarTab(t.dataset.tab)));

async function abrirConfig(tab = 'tabSso') {
  mostrarTab(tab);
  $('#formPassword').reset();
  limpiarFormAdmin();
  $('#dlgConfig').showModal();
  await Promise.all([cargarSso(), cargarAdmins()]).catch((err) => toast(err.message, true));
}
$('#btnConfig').addEventListener('click', () => abrirConfig());

// --- SSO ---
async function cargarSso() {
  const cfg = await api('/api/admin/sso');
  const f = $('#formSso');
  f.tenantId.value = cfg.tenantId;
  f.clientId.value = cfg.clientId;
  f.clientSecret.value = '';
  f.secretoVence.value = cfg.secretoVence;
  f.dominiosPermitidos.value = cfg.dominiosPermitidos;
  f.permisosAplicacion.checked = cfg.permisosAplicacion;
  f.buzonAdmin.value = cfg.buzonAdmin;
  f.enviarConfirmacion.checked = cfg.enviarConfirmacion;
  $('#ssoRedirect').value = cfg.redirectUri;
  $('#ssoSecretoHint').textContent = cfg.secretoConfigurado
    ? 'Hay un secreto guardado (no se muestra). Déjelo en blanco para conservarlo; escriba uno nuevo solo para reemplazarlo.'
    : 'Pegue aquí la columna "Valor" del secreto creado en Azure (no el "Id. de secreto").';
  f.clientSecret.placeholder = cfg.secretoConfigurado ? '•••••••• (guardado)' : '';
  const [clase, mensaje] = estadoSso(cfg);
  const estado = $('#ssoEstado');
  estado.className = `estado ${clase}`;
  estado.textContent = mensaje;
  $('#ssoActualizado').textContent = cfg.actualizadoEn
    ? `Última modificación: ${new Date(cfg.actualizadoEn).toLocaleString('es')}${cfg.actualizadoPor ? ` por ${cfg.actualizadoPor}` : ''}`
    : '';
}

function datosSso() {
  const f = $('#formSso');
  return {
    tenantId: f.tenantId.value,
    clientId: f.clientId.value,
    clientSecret: f.clientSecret.value,
    secretoVence: f.secretoVence.value,
    dominiosPermitidos: f.dominiosPermitidos.value,
    permisosAplicacion: f.permisosAplicacion.checked,
    buzonAdmin: f.buzonAdmin.value,
    enviarConfirmacion: f.enviarConfirmacion.checked,
  };
}

async function conBoton(boton, textoEspera, fn) {
  const original = boton.textContent;
  boton.disabled = true;
  boton.textContent = textoEspera;
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    boton.disabled = false;
    boton.textContent = original;
  }
}

$('#btnProbarSso').addEventListener('click', (e) =>
  conBoton(e.currentTarget, 'Probando…', async () => {
    const r = await api('/api/admin/sso/probar', { method: 'POST', body: datosSso() });
    toast(r.mensaje);
  })
);

$('#formSso').addEventListener('submit', (e) => {
  e.preventDefault();
  conBoton(e.submitter || $('#formSso button[type=submit]'), 'Verificando con Microsoft…', async () => {
    await api('/api/admin/sso', { method: 'PUT', body: datosSso() });
    toast('Configuración de Microsoft 365 guardada y verificada');
    await cargarSso();
    revisarAvisosAdmin();
  });
});

$('#btnCopiarRedirect').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#ssoRedirect').value);
    toast('URI copiada');
  } catch {
    $('#ssoRedirect').select();
  }
});

// --- Administradores ---
let administradores = [];
const fmtFechaHora = (v) => (v ? new Date(v).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—');

async function cargarAdmins() {
  administradores = await api('/api/admin/administradores');
  $('#tablaAdmins').innerHTML = administradores
    .map((a) => `<tr>
      <td>${esc(a.nombre)}${a.esYo ? ' <span class="badge">usted</span>' : ''}<br><small class="muted">${esc(a.username)}${a.email ? ` · ${esc(a.email)}` : ''}</small></td>
      <td>${a.solo_lectura ? '<span class="badge visor">Solo visualización</span>' : '<span class="badge admin">Administrador</span>'}</td>
      <td>${fmtFechaHora(a.ultimo_acceso)}</td>
      <td>${a.activo ? 'Activo' : '<span class="muted">Inactivo</span>'}</td>
      <td><button type="button" class="btn-sec" data-editar-admin="${a.id}">Editar</button></td></tr>`)
    .join('');
}

function limpiarFormAdmin() {
  const f = $('#formAdmin');
  f.reset();
  f.id.value = '';
  f.username.disabled = false;
  f.activo.checked = true;
  f.perfil.value = 'admin';
  f.perfil.disabled = false;
  $('#chkAdminActivo').hidden = true;
  $('#lblAdminPass').textContent = 'Contraseña (mín. 8)';
  $('#formAdminTitulo').textContent = 'Nueva cuenta';
}
$('#btnAdminLimpiar').addEventListener('click', limpiarFormAdmin);

$('#tablaAdmins').addEventListener('click', (e) => {
  const id = e.target.dataset.editarAdmin;
  if (!id) return;
  const a = administradores.find((x) => String(x.id) === id);
  const f = $('#formAdmin');
  f.id.value = a.id;
  f.username.value = a.username;
  f.username.disabled = true;
  f.nombre.value = a.nombre;
  f.email.value = a.email || '';
  f.password.value = '';
  f.activo.checked = a.activo;
  f.perfil.value = a.solo_lectura ? 'visor' : 'admin';
  f.perfil.disabled = a.esYo; // no puede quitarse a sí mismo los permisos
  $('#chkAdminActivo').hidden = a.esYo; // no puede desactivarse a sí mismo
  $('#lblAdminPass').textContent = 'Nueva contraseña (vacío = no cambiar)';
  $('#formAdminTitulo').textContent = `Editar: ${a.nombre}`;
});

$('#formAdmin').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const datos = {
    nombre: f.nombre.value,
    email: f.email.value,
    password: f.password.value,
    soloLectura: f.perfil.value === 'visor',
  };
  conBoton(e.submitter || f.querySelector('button[type=submit]'), 'Guardando…', async () => {
    if (f.id.value) {
      await api(`/api/admin/administradores/${f.id.value}`, { method: 'PUT', body: { ...datos, activo: f.activo.checked } });
    } else {
      await api('/api/admin/administradores', { method: 'POST', body: { ...datos, username: f.username.value } });
    }
    toast('Cuenta guardada');
    limpiarFormAdmin();
    await cargarAdmins();
  });
});

// --- Mi contraseña ---
$('#formPassword').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.nueva.value !== f.repetir.value) return toast('Las contraseñas nuevas no coinciden', true);
  conBoton(e.submitter || f.querySelector('button[type=submit]'), 'Guardando…', async () => {
    await api('/api/admin/mi-password', { method: 'PUT', body: { actual: f.actual.value, nueva: f.nueva.value } });
    f.reset();
    toast('Contraseña actualizada');
  });
});

iniciar().catch((err) => toast(err.message, true));
