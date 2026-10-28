require('dotenv').config({ quiet: true });

function requerida(nombre) {
  const valor = process.env[nombre];
  if (!valor) {
    console.error(`Falta la variable de entorno ${nombre} (ver .env.example)`);
    process.exit(1);
  }
  return valor;
}

const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const sessionSecret = requerida('SESSION_SECRET');

// La configuración de Microsoft 365 (tenant, client id, secreto) NO va aquí:
// se administra desde la página de administración y se guarda en la tabla config_sso.
module.exports = {
  port: Number(process.env.PORT) || 3000,
  baseUrl,
  redirectUri: `${baseUrl}/auth/callback`,
  trustProxy: process.env.TRUST_PROXY === 'true',
  // Zona horaria con la que se muestran fechas en los correos de confirmación
  zonaHoraria: process.env.ZONA_HORARIA || 'America/Santiago',
  cookieSegura: baseUrl.startsWith('https://'),
  sessionSecret,
  // Clave para cifrar el secreto de cliente en la BD. Si cambia, hay que volver a ingresar el secreto.
  claveCifrado: process.env.CLAVE_CIFRADO || sessionSecret,
  // Conexión: DATABASE_URL, o bien parámetros sueltos (permite contraseñas con cualquier carácter)
  database: process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: requerida('DB_HOST'),
        port: Number(process.env.DB_PORT) || 5432,
        user: requerida('POSTGRES_USER'),
        password: requerida('POSTGRES_PASSWORD'),
        database: requerida('POSTGRES_DB'),
      },
  databaseSsl: process.env.DATABASE_SSL === 'true',
};
