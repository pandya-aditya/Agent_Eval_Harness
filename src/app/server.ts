import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { checkPassword } from "./db.js";
export function createApp(pool: Pool) {
  const app = express();
  const sessions = new Map<
    string,
    { id: number; email: string; expires: number }
  >();
  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    const runId = String(req.get("x-tracebench-run-id") ?? "manual")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 80);
    res.on("finish", () => {
      if (path.startsWith("/api"))
        console.log(
          JSON.stringify({
            runId,
            method: req.method,
            path,
            operation: res.locals.operation ?? "request",
            rows: res.locals.rows ?? 0,
            durationMs: Date.now() - start,
            outcome: res.statusCode,
          }),
        );
    });
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.use("/api", (req, res, next) => {
    if (
      ["POST", "PATCH"].includes(req.method) &&
      req.get("origin") &&
      req.get("origin") !== `http://${req.get("host")}`
    ) {
      res.status(403).json({ error: "Cross-origin requests are not allowed." });
      return;
    }
    next();
  });
  const token = (req: Request) =>
    req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("billing_session="))
      ?.slice(16);
  app.get("/api/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ready: true });
  });
  app.post("/api/login", async (req, res) => {
    const { email, password } = req.body ?? {};
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      password.length > 200
    ) {
      res.status(400).json({ error: "Email and password are required." });
      return;
    }
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [
      email,
    ]);
    const user = result.rows[0];
    if (!user || !checkPassword(password, user.password_hash)) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }
    const old = token(req);
    if (old) sessions.delete(old);
    for (const [key, session] of sessions)
      if (session.expires < Date.now()) sessions.delete(key);
    const id = randomBytes(32).toString("hex");
    sessions.set(id, {
      id: user.id,
      email: user.email,
      expires: Date.now() + 8 * 60 * 60 * 1000,
    });
    res.cookie("billing_session", id, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ id: user.id, email: user.email });
  });
  app.use("/api", (req, res, next) => {
    const id = token(req);
    const session = id ? sessions.get(id) : undefined;
    if (!session || session.expires < Date.now()) {
      if (id) sessions.delete(id);
      res.status(401).json({ error: "Please sign in." });
      return;
    }
    res.locals.user = { id: session.id, email: session.email };
    next();
  });
  app.get("/api/session", (_req, res) => res.json(res.locals.user));
  app.post("/api/logout", (req, res) => {
    sessions.delete(token(req)!);
    res.clearCookie("billing_session");
    res.status(204).end();
  });
  const invoiceSelect = `SELECT i.*, to_char(i.due_date,'YYYY-MM-DD') AS due_date, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id`;
  app.get("/api/invoices", async (_req, res) => {
    const result = await pool.query(`${invoiceSelect} ORDER BY invoice_number`);
    res.locals.rows = result.rowCount;
    res.json(result.rows);
  });
  app.param("id", (req, res, next, value) => {
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1 ||
      Number(value) > 2147483647
    ) {
      res.status(400).json({ error: "Invalid record ID." });
      return;
    }
    next();
  });
  app.get("/api/invoices/:id", async (req, res) => {
    const result = await pool.query(`${invoiceSelect} WHERE i.id=$1`, [
      req.params.id,
    ]);
    if (!result.rowCount) {
      res.status(404).json({ error: "Invoice not found." });
      return;
    }
    res.json(result.rows[0]);
  });
  for (const [action, status] of [
    ["void", "VOID"],
    ["pay", "PAID"],
  ]) {
    app.post(`/api/invoices/:id/${action}`, async (req, res) => {
      res.locals.operation = `invoice.${action}`;
      const result = await pool.query(
        "UPDATE invoices SET status=$1 WHERE id=$2 AND status='PENDING' RETURNING *",
        [status, req.params.id],
      );
      res.locals.rows = result.rowCount;
      if (!result.rowCount) {
        const exists = await pool.query("SELECT id FROM invoices WHERE id=$1", [
          req.params.id,
        ]);
        res.status(exists.rowCount ? 409 : 404).json({
          error: exists.rowCount
            ? "Only pending invoices can change status."
            : "Invoice not found.",
        });
        return;
      }
      res.json(result.rows[0]);
    });
  }
  app.get("/api/customers/:id", async (req, res) => {
    const result = await pool.query("SELECT * FROM customers WHERE id=$1", [
      req.params.id,
    ]);
    if (!result.rowCount) {
      res.status(404).json({ error: "Customer not found." });
      return;
    }
    res.json(result.rows[0]);
  });
  app.patch("/api/customers/:id", async (req, res) => {
    const { billing_email, billing_address } = req.body ?? {};
    if (
      typeof billing_email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billing_email) ||
      billing_email.length > 254 ||
      typeof billing_address !== "string" ||
      !billing_address.trim() ||
      billing_address.length > 1000 ||
      Object.keys(req.body).some(
        (k) => !["billing_email", "billing_address"].includes(k),
      )
    ) {
      res.status(400).json({
        error:
          "Provide a valid billing email and a nonempty billing address (up to 1000 characters).",
      });
      return;
    }
    res.locals.operation = "customer.updateBilling";
    const result = await pool.query(
      "UPDATE customers SET billing_email=$1,billing_address=$2 WHERE id=$3 RETURNING *",
      [billing_email.trim(), billing_address.trim(), req.params.id],
    );
    res.locals.rows = result.rowCount;
    if (!result.rowCount) {
      res.status(404).json({ error: "Customer not found." });
      return;
    }
    res.json(result.rows[0]);
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use(express.static(resolve("dist/web")));
  app.get("/", (_req, res) => res.sendFile(resolve("dist/web/index.html")));
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const malformed = error instanceof SyntaxError;
      res.status(malformed ? 400 : 503).json({
        error: malformed
          ? "Invalid JSON."
          : "Service unavailable. Check that PostgreSQL is running and retry.",
      });
    },
  );
  return app;
}
export async function startServer(pool: Pool, port = 3001) {
  const server = createApp(pool).listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
