// Herramienta de RECUPERACIÓN: crea un administrador o restablece su contraseña desde la consola
// (por ejemplo, si nadie recuerda la clave). Normalmente los administradores se crean desde la web.
// Uso en Docker:  docker compose exec app node scripts/crear-admin.js <usuario> <contraseña> ["Nombre"] [email]
// Uso local:      npm run crear-admin -- <usuario> <contraseña> ["Nombre"] [email]
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { normalizarUsuario } = require('../src/middleware');

(async () => {
  const [usuarioIngresado, password, nombre, email] = process.argv.slice(2);
  const usuario = normalizarUsuario(usuarioIngresado);
  if (!usuario || !password) {
    console.error('Uso: node scripts/crear-admin.js <usuario> <contraseña> ["Nombre"] [email]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('La contraseña debe tener al menos 8 caracteres.');
    process.exit(1);
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows: [existente] } = await pool.query(
      `SELECT id, tipo FROM usuarios WHERE username = $1`,
      [usuario]
    );
    if (existente && existente.tipo !== 'admin') {
      console.error(`El usuario "${usuario}" existe pero no es administrador.`);
      process.exitCode = 1;
    } else if (existente) {
      await pool.query(
        `UPDATE usuarios SET password_hash = $1, activo = TRUE,
                nombre = COALESCE($2, nombre), email = COALESCE($3, email)
          WHERE id = $4`,
        [hash, nombre || null, email || null, existente.id]
      );
      console.log(`Contraseña del administrador "${usuario}" restablecida y usuario activado.`);
    } else {
      await pool.query(
        `INSERT INTO usuarios (tipo, username, password_hash, nombre, email) VALUES ('admin', $1, $2, $3, $4)`,
        [usuario, hash, nombre || 'Administrador', email || null]
      );
      console.log(`Administrador "${usuario}" creado.`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
