import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    "[db] DATABASE_URL is not set. Copy .env.example to .env and fill in your Neon connection string."
  );
}

// Neon works well with a small pool since it is serverless-friendly and
// automatically scales connections at the platform level.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  // Prevents an idle client error from crashing the whole process.
  console.error("[db] Unexpected error on idle client", err);
});

/**
 * Always prefer this helper (parameterized queries) over string
 * concatenation anywhere in the codebase - this is what eliminates SQL
 * injection risk. Never interpolate user input directly into SQL text.
 */
export async function query(text, params = []) {
  const start = Date.now();
  const result = await pool.query(text, params);
  if (process.env.NODE_ENV !== "production") {
    console.log("[db]", text.replace(/\s+/g, " ").trim(), `(${Date.now() - start}ms)`);
  }
  return result;
}
