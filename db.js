const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function connectDB() {
  try {
    const client = await pool.connect();
    console.log("PostgreSQL Connected ✅");
    client.release();
  } catch (err) {
    console.log("DB Error ❌", err);
  }
}

module.exports = { pool, connectDB };