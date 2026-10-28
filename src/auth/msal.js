const msal = require('@azure/msal-node');
const { HttpError } = require('../middleware');
const { obtenerConfigSso } = require('../sso-config');

// Permisos DELEGADOS (los otorga cada usuario al iniciar sesión)
const SCOPES = ['User.Read', 'User.ReadBasic.All', 'Calendars.ReadWrite'];
const SCOPE_MAIL = ['Mail.Send'];
const SCOPE_APP = ['https://graph.microsoft.com/.default'];

/** Permisos a pedir al iniciar sesión: Mail.Send solo si está activo el correo de confirmación. */
const scopesLogin = (cfg) => (cfg.enviarConfirmacion ? [...SCOPES, ...SCOPE_MAIL] : SCOPES);

const authority = (tenantId) => `https://login.microsoftonline.com/${tenantId}`;

/**
 * Crea un cliente MSAL con la configuración `cfg` cuya caché de tokens (incluye
 * refresh token) se guarda en `almacen.msalCache`. Normalmente `almacen` es
 * req.session, por lo que la caché queda persistida en PostgreSQL junto a la sesión.
 */
function crearCliente(cfg, almacen) {
  return new msal.ConfidentialClientApplication({
    auth: { clientId: cfg.clientId, clientSecret: cfg.clientSecret, authority: authority(cfg.tenantId) },
    cache: {
      cachePlugin: {
        beforeCacheAccess: async (ctx) => {
          if (almacen.msalCache) ctx.tokenCache.deserialize(almacen.msalCache);
        },
        afterCacheAccess: async (ctx) => {
          if (ctx.cacheHasChanged) almacen.msalCache = ctx.tokenCache.serialize();
        },
      },
    },
  });
}

const SESION_EXPIRADA = 'La sesión de Microsoft expiró, vuelva a iniciar sesión';

/** Token delegado del usuario logueado (renueva automáticamente con el refresh token). */
async function obtenerTokenUsuario(session, scopes = SCOPES) {
  const cfg = await obtenerConfigSso();
  if (!cfg.habilitado) throw new HttpError(401, SESION_EXPIRADA);
  const cliente = crearCliente(cfg, session);
  const cuenta = await cliente.getTokenCache().getAccountByHomeId(session.usuario?.homeAccountId);
  if (!cuenta) throw new HttpError(401, SESION_EXPIRADA);
  try {
    const r = await cliente.acquireTokenSilent({ account: cuenta, scopes });
    return r.accessToken;
  } catch (err) {
    // InteractionRequired o credenciales de la app cambiadas: el usuario debe volver a entrar
    console.warn('No se pudo renovar el token del usuario:', err.errorCode || err.message);
    throw new HttpError(401, SESION_EXPIRADA);
  }
}

// Cliente con permisos de APLICACIÓN (client credentials). Se recrea si cambia la configuración.
let clienteApp = null;
let firmaClienteApp = '';
async function obtenerTokenApp() {
  const cfg = await obtenerConfigSso();
  if (!cfg.appHabilitada) {
    throw new HttpError(400, 'Los permisos de aplicación de Microsoft Graph no están habilitados');
  }
  const firma = `${cfg.tenantId}|${cfg.clientId}|${cfg.clientSecret}`;
  if (!clienteApp || firma !== firmaClienteApp) {
    clienteApp = new msal.ConfidentialClientApplication({
      auth: { clientId: cfg.clientId, clientSecret: cfg.clientSecret, authority: authority(cfg.tenantId) },
    });
    firmaClienteApp = firma;
  }
  const r = await clienteApp.acquireTokenByClientCredential({ scopes: SCOPE_APP });
  return r.accessToken;
}

/**
 * Verifica tenant + client id + secreto pidiendo un token a Entra ID.
 * Devuelve null si son válidos o un mensaje de error legible.
 */
async function probarCredenciales({ tenantId, clientId, clientSecret }) {
  try {
    const cliente = new msal.ConfidentialClientApplication({
      auth: { clientId, clientSecret, authority: authority(tenantId) },
    });
    await cliente.acquireTokenByClientCredential({ scopes: SCOPE_APP });
    return null;
  } catch (err) {
    const texto = `${err.errorCode || ''} ${err.errorMessage || err.message || ''}`;
    if (/AADSTS7000215|invalid_client/i.test(texto)) return 'El secreto de cliente es inválido (¿copió el "Id. de secreto" en vez del "Valor"?).';
    if (/AADSTS7000222/i.test(texto)) return 'El secreto de cliente está vencido. Genere uno nuevo en Azure.';
    if (/AADSTS700016|unauthorized_client/i.test(texto)) return 'El Id. de aplicación (cliente) no existe en ese tenant.';
    if (/AADSTS90002|AADSTS900023|tenant|endpoints_resolution/i.test(texto)) return 'El Id. de directorio (tenant) es inválido.';
    return `Microsoft rechazó las credenciales: ${texto.trim().split('\n')[0].slice(0, 300)}`;
  }
}

module.exports = {
  SCOPES,
  SCOPE_MAIL,
  scopesLogin,
  crearCliente,
  obtenerTokenUsuario,
  obtenerTokenApp,
  probarCredenciales,
  CryptoProvider: msal.CryptoProvider,
};
