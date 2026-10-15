import "dotenv/config";
import { Pool } from "pg";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
export const DEMO_EMAIL = "demo@tracebench.local";
export const DEMO_PASSWORD = "tracebench-demo";
export function createPool() {
  return new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/tracebench_dev",
    connectionTimeoutMillis: 2000,
    query_timeout: 10000,
  });
}
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function checkPassword(password: string, hash: string) {
  const [salt, key] = hash.split(":");
  const actual = scryptSync(password, salt!, 64);
  const expected = Buffer.from(key!, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function migrate(pool: Pool) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(1042001)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)",
    );
    const applied = await db.query(
      "SELECT version FROM schema_migrations WHERE version=1",
    );
    if (!applied.rowCount) {
      await db.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
        CREATE TABLE customers (id SERIAL PRIMARY KEY, name TEXT NOT NULL, billing_email TEXT NOT NULL, billing_address TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS invoices (id SERIAL PRIMARY KEY, invoice_number VARCHAR(50), status VARCHAR(20));
        ALTER TABLE invoices ADD COLUMN customer_id INTEGER REFERENCES customers(id), ADD COLUMN amount_cents INTEGER NOT NULL DEFAULT 0 CHECK(amount_cents >= 0), ADD COLUMN due_date DATE NOT NULL DEFAULT '2026-11-01';
        ALTER TABLE invoices ALTER COLUMN invoice_number SET NOT NULL, ALTER COLUMN status SET NOT NULL;
        ALTER TABLE invoices ADD CONSTRAINT invoices_number_unique UNIQUE(invoice_number), ADD CONSTRAINT invoices_status_valid CHECK(status IN ('PENDING','PAID','VOID'));
        INSERT INTO schema_migrations VALUES (1);`);
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export async function seed(pool: Pool) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("TRUNCATE invoices, customers, users RESTART IDENTITY");
    await db.query("INSERT INTO users(email,password_hash) VALUES($1,$2)", [
      DEMO_EMAIL,
      hashPassword(DEMO_PASSWORD),
    ]);
    await db.query(`INSERT INTO customers(name,billing_email,billing_address) VALUES ('Northstar Studio','billing@northstar.example','10 King Street, Toronto'), ('Cedar Works','accounts@cedar.example','20 Queen Street, Ottawa');
      INSERT INTO invoices(invoice_number,status,customer_id,amount_cents,due_date) VALUES ('1042','PENDING',1,125000,'2026-11-01'), ('1043','PENDING',2,48000,'2026-11-15'), ('1044','PAID',1,75000,'2026-10-01'), ('1045','VOID',2,22000,'2026-10-15');`);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export async function snapshot(pool: Pool) {
  const invoices = await pool.query("SELECT * FROM invoices ORDER BY id");
  const customers = await pool.query("SELECT * FROM customers ORDER BY id");
  const users = await pool.query("SELECT * FROM users ORDER BY id");
  return {
    invoices: invoices.rows,
    customers: customers.rows,
    users: users.rows,
  };
}
