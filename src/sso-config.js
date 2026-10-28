// Configuración del SSO de Microsoft 365 almacenada en la BD (tabla config_sso).
const crypto = require('crypto');
const config = require('./config');
const { query } = require('./db');

const CLAVE = crypto.createHash('sha256').update(`config-sso:${config.claveCifrado}`).digest();

function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CLAVE, iv);
  const datos = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), datos.toString('base64')].join(':');
}

function descifrar(valor) {
  try {
    const [, iv, tag, datos] = valor.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', CLAVE, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(datos, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // la clave de cifrado cambió: hay que volver a ingresar el secreto
  }
}

// Caché corta para no consultar la BD en cada request (y para que otras instancias se enteren de cambios)
const TTL_MS = 30 * 1000;
let cache = null;

async function obtenerConfigSso() {
  if (cache && cache.expira > Date.now()) return cache.valor;

  const { rows: [r = {}] } = await query(
    `SELECT tenant_id, client_id, client_secret_cifrado, to_char(secreto_vence, 'YYYY-MM-DD') AS secreto_vence,
            dominios_permitidos, permisos_aplicacion, buzon_admin, enviar_confirmacion
       FROM config_sso WHERE id = 1`
  );
  const clientSecret = r.client_secret_cifrado ? descifrar(r.client_secret_cifrado) : null;
  const habilitado = Boolean(r.tenant_id && r.client_id && clientSecret);
  const appHabilitada = habilitado && r.permisos_aplicacion === true;

  const valor = {
    habilitado,
    tenantId: r.tenant_id || null,
    clientId: r.client_id || null,
    clientSecret,
    secretoIlegible: Boolean(r.client_secret_cifrado && !clientSecret),
    secretoVence: r.secreto_vence || null,
    dominiosPermitidos: (r.dominios_permitidos || '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    appHabilitada,
    buzonAdmin: appHabilitada ? r.buzon_admin || null : null,
    enviarConfirmacion: habilitado && r.enviar_confirmacion === true,
  };
  cache = { valor, expira: Date.now() + TTL_MS };
  return valor;
}

/** Guarda la configuración. Si clientSecret viene vacío se conserva el secreto actual. */
async function guardarConfigSso(datos, usuarioId) {
  await query(
    `UPDATE config_sso SET
        tenant_id = $1, client_id = $2,
        client_secret_cifrado = COALESCE($3, client_secret_cifrado),
        secreto_vence = $4, dominios_permitidos = $5, permisos_aplicacion = $6, buzon_admin = $7,
        enviar_confirmacion = $9, actualizado_en = now(), actualizado_por = $8
      WHERE id = 1`,
    [
      datos.tenantId,
      datos.clientId,
      datos.clientSecret ? cifrar(datos.clientSecret) : null,
      datos.secretoVence,
      datos.dominiosPermitidos,
      datos.permisosAplicacion,
      datos.buzonAdmin,
      usuarioId,
      datos.enviarConfirmacion === true,
    ]
  );
  cache = null;
}

module.exports = { obtenerConfigSso, guardarConfigSso };
