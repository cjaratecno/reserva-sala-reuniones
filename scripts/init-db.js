// Crea/actualiza las tablas en PostgreSQL ejecutando db/schema.sql
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('Base de datos inicializada correctamente.');
  } catch (err) {
    console.error('Error inicializando la base de datos:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
