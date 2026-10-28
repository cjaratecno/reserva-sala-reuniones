const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  ...config.database,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

pool.on('error', (err) => console.error('Error inesperado en PostgreSQL:', err));

function query(text, params) {
  return pool.query(text, params);
}

/** Ejecuta fn(client) dentro de una transacción; hace ROLLBACK si fn lanza error. */
async function conTransaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, conTransaccion };
