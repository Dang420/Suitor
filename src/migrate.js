// Runs the idempotent schema migration, then exits.
require('dotenv').config();
const { migrate, pool } = require('./db');

migrate()
  .then(() => {
    console.log('migrations ok');
    return pool.end();
  })
  .catch((err) => {
    console.error('migration failed', err);
    process.exit(1);
  });
