const GRAPH_URL = 'https://graph.microsoft.com/v1.0';

async function llamarGraph(token, metodo, ruta, cuerpo, headersExtra = {}) {
  const res = await fetch(GRAPH_URL + ruta, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headersExtra },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  if (!res.ok) {
    const detalle = await res.text();
    const err = new Error(`Microsoft Graph respondió ${res.status}: ${detalle}`);
    err.status = 502;
    err.graphStatus = res.status;
    err.mensajePublico = 'Error al comunicarse con Microsoft 365. Intente nuevamente.';
    throw err;
  }
  if (res.status === 202 || res.status === 204) return null;
  return res.json();
}

const escaparHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Graph acepta dateTime sin zona + timeZone; se envía todo en UTC y Outlook lo
// muestra en la zona horaria de cada invitado.
const aGraphUtc = (fecha) => ({ dateTime: fecha.toISOString().replace('Z', ''), timeZone: 'UTC' });

/**
 * Crea el evento en el calendario del organizador. Exchange envía automáticamente
 * la invitación a cada asistente y la reunión queda en sus calendarios.
 * ctx = { token, base } donde base es '/me' (delegado) o '/users/{email}' (aplicación).
 */
async function crearEvento(ctx, { titulo, descripcion, inicio, fin, sala, asistentes, teams, reservaId }) {
  const invitados = asistentes.map((a) => ({
    emailAddress: { address: a.email, name: a.nombre || a.email },
    type: 'required',
  }));
  // Si la sala tiene buzón de recurso en Exchange, se invita también como recurso
  if (sala.email_recurso) {
    invitados.push({ emailAddress: { address: sala.email_recurso, name: sala.nombre }, type: 'resource' });
  }

  const cuerpoHtml =
    (descripcion ? `<p>${escaparHtml(descripcion).replace(/\n/g, '<br>')}</p>` : '') +
    `<p style="color:#666;font-size:12px">Sala: ${escaparHtml(sala.nombre)}` +
    (sala.ubicacion ? ` — ${escaparHtml(sala.ubicacion)}` : '') +
    ` · Reserva #${reservaId}</p>`;

  const evento = {
    subject: titulo,
    body: { contentType: 'HTML', content: cuerpoHtml },
    start: aGraphUtc(inicio),
    end: aGraphUtc(fin),
    location: {
      displayName: sala.nombre,
      ...(sala.email_recurso ? { locationEmailAddress: sala.email_recurso } : {}),
    },
    attendees: invitados,
    allowNewTimeProposals: false,
    responseRequested: true,
    ...(teams ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
  };

  return llamarGraph(ctx.token, 'POST', `${ctx.base}/events`, evento);
}

/** Cancela el evento: Exchange envía la cancelación a todos los invitados. */
function cancelarEvento(ctx, eventId, comentario) {
  return llamarGraph(ctx.token, 'POST', `${ctx.base}/events/${encodeURIComponent(eventId)}/cancel`, {
    comment: comentario || 'La reserva de la sala fue cancelada.',
  });
}

/**
 * Correo de confirmación para quien reserva. Exchange no envía la invitación al
 * organizador de su propia reunión, así que se le manda este resumen desde su cuenta.
 */
function enviarConfirmacion(token, { para, titulo, descripcion, inicio, fin, sala, asistentes, linkTeams, zonaHoraria }) {
  const fecha = new Intl.DateTimeFormat('es-CL', { timeZone: zonaHoraria, dateStyle: 'full' }).format(inicio);
  const hora = new Intl.DateTimeFormat('es-CL', { timeZone: zonaHoraria, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fila = (k, v) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:6px 0">${v}</td></tr>`;
  const invitados = asistentes.length
    ? asistentes.map((a) => escaparHtml(a.nombre ? `${a.nombre} <${a.email}>` : a.email)).join('<br>')
    : 'Sin invitados';

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2937;max-width:560px">
      <div style="border-top:4px solid #f0b429;padding:16px 0 4px"><h2 style="margin:0 0 4px">Reserva confirmada</h2>
      <p style="margin:0 0 12px;color:#6b7280">La sala quedó reservada y se envió la invitación de Outlook a los asistentes.</p></div>
      <table style="border-collapse:collapse">
        ${fila('Reunión', `<b>${escaparHtml(titulo)}</b>`)}
        ${fila('Fecha', escaparHtml(fecha.charAt(0).toUpperCase() + fecha.slice(1)))}
        ${fila('Horario', `${hora.format(inicio)} – ${hora.format(fin)}`)}
        ${fila('Sala', escaparHtml(sala.nombre + (sala.ubicacion ? ` — ${sala.ubicacion}` : '')))}
        ${fila('Invitados', invitados)}
        ${descripcion ? fila('Descripción', escaparHtml(descripcion).replace(/\n/g, '<br>')) : ''}
        ${linkTeams ? fila('Teams', `<a href="${escaparHtml(linkTeams)}">Unirse a la reunión</a>`) : ''}
      </table>
      <p style="margin-top:16px;color:#9ca3af;font-size:12px">La reunión ya está en su calendario de Outlook. Para cancelarla use el sistema de Reserva de Salas.</p>
    </div>`;

  return llamarGraph(token, 'POST', '/me/sendMail', {
    message: {
      subject: `Reserva confirmada: ${titulo}`,
      body: { contentType: 'HTML', content: html },
      toRecipients: [{ emailAddress: { address: para } }],
    },
    saveToSentItems: false,
  });
}

/**
 * Foto de perfil de un usuario de Microsoft 365 (64x64 o, si no existe ese tamaño, la original).
 * Devuelve { datos: Buffer, tipo } o null si no tiene foto / no es un usuario del tenant.
 */
async function obtenerFoto(token, email) {
  const base = `${GRAPH_URL}/users/${encodeURIComponent(email)}`;
  for (const ruta of ['/photos/64x64/$value', '/photo/$value']) {
    const res = await fetch(base + ruta, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      return { datos: Buffer.from(await res.arrayBuffer()), tipo: res.headers.get('content-type') || 'image/jpeg' };
    }
    if (res.status !== 404) {
      // 403 = sin permiso, 400 = correo externo, etc.: se trata como "sin foto"
      if (res.status >= 500 || res.status === 429) console.warn(`Foto de ${email}: Graph respondió ${res.status}`);
      return null;
    }
  }
  return null;
}

/**
 * Agenda (disponibilidad libre/ocupado) de varias personas entre inicio y fin.
 * Usa calendar/getSchedule; Graph acepta hasta 20 personas por llamada.
 * Las horas vuelven en UTC gracias al header Prefer.
 */
async function obtenerAgendas(ctx, emails, inicio, fin) {
  const resultado = [];
  for (let i = 0; i < emails.length; i += 20) {
    const data = await llamarGraph(
      ctx.token,
      'POST',
      `${ctx.base}/calendar/getSchedule`,
      { schedules: emails.slice(i, i + 20), startTime: aGraphUtc(inicio), endTime: aGraphUtc(fin), availabilityViewInterval: 15 },
      { Prefer: 'outlook.timezone="UTC"' }
    );
    resultado.push(...data.value);
  }
  return resultado;
}

async function buscarPersonas(token, texto) {
  const t = texto.replace(/'/g, "''");
  const filtro = ['displayName', 'mail', 'givenName', 'surname'].map((c) => `startswith(${c},'${t}')`).join(' or ');
  const data = await llamarGraph(
    token,
    'GET',
    `/users?$filter=${encodeURIComponent(filtro)}&$select=displayName,mail,jobTitle&$top=10`
  );
  return data.value
    .filter((u) => u.mail)
    .map((u) => ({ nombre: u.displayName, email: u.mail, cargo: u.jobTitle || null }));
}

module.exports = {
  llamarGraph,
  crearEvento,
  cancelarEvento,
  enviarConfirmacion,
  buscarPersonas,
  obtenerFoto,
  obtenerAgendas,
};
