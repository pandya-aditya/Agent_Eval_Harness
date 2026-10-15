import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPool,
  migrate,
  seed,
  snapshot,
  DEMO_EMAIL,
  DEMO_PASSWORD,
} from "../src/app/db.js";
import { startServer } from "../src/app/server.js";
import { chromium } from "playwright";
import { login } from "../src/harness/runner.js";
import { verifyChange } from "../src/harness/tasks.js";
test("migration preserves the original PoC invoice and is idempotent", async () => {
  const pool = createPool();
  const db = await pool.connect();
  try {
    await db.query("CREATE SCHEMA tracebench_migration_test");
    await db.query("SET search_path TO tracebench_migration_test");
    await db.query(
      "CREATE TABLE invoices(id SERIAL PRIMARY KEY,invoice_number VARCHAR(50),status VARCHAR(20)); INSERT INTO invoices(invoice_number,status) VALUES('1042','VOID')",
    );
    const wrapper = {
      connect: async () => ({ query: db.query.bind(db), release: () => {} }),
    } as unknown as typeof pool;
    await migrate(wrapper);
    await migrate(wrapper);
    const result = await db.query("SELECT invoice_number,status FROM invoices");
    assert.deepEqual(result.rows, [{ invoice_number: "1042", status: "VOID" }]);
  } finally {
    await db.query("SET search_path TO public");
    await db.query("DROP SCHEMA IF EXISTS tracebench_migration_test CASCADE");
    db.release();
    await pool.end();
  }
});
test("API validation, sessions, status concurrency, and browser cancellation", async () => {
  const pool = createPool();
  await migrate(pool);
  await seed(pool);
  const server = await startServer(pool, 0);
  let cookie = "";
  const request = async (path: string, method = "GET", body?: unknown) =>
    fetch(server.url + "/api" + path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await request("/invoices")).status, 401);
    assert.equal((await request("/health")).status, 200);
    assert.equal(
      (
        await request("/login", "POST", {
          email: DEMO_EMAIL,
          password: "wrong",
        })
      ).status,
      401,
    );
    const auth = await request("/login", "POST", {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    });
    assert.equal(auth.status, 200);
    cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    assert.match(auth.headers.get("set-cookie")!, /HttpOnly/);
    assert.match(auth.headers.get("set-cookie")!, /SameSite=Lax/);
    assert.equal(
      (
        await request("/customers/1", "PATCH", {
          billing_email: "invalid",
          billing_address: "",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/customers/1", "PATCH", {
          billing_email: "ok@example.com",
          billing_address: " ",
          name: "Overwrite",
        })
      ).status,
      400,
    );
    assert.equal((await request("/invoices/999")).status, 404);
    assert.equal((await request("/invoices/nope")).status, 400);
    assert.equal((await request("/customers/999")).status, 404);
    assert.equal((await request("/invoices/3/void", "POST")).status, 409);
    const duplicate = await Promise.all([
      request("/invoices/1/void", "POST"),
      request("/invoices/1/pay", "POST"),
    ]);
    assert.deepEqual(duplicate.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await request("/invoices/1/void", "POST")).status, 409);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(server.url);
      await login(page, () => {});
      await page
        .getByRole("link", { name: "Invoice #1043", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Void invoice", exact: true })
        .click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(
        await page.getByTestId("invoice-status").textContent(),
        "PENDING",
      );
      assert.equal(
        (await pool.query("SELECT status FROM invoices WHERE id=2")).rows[0]
          .status,
        "PENDING",
      );
      await page.route("**/api/invoices/2/void", (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Service unavailable. Retry." }),
        }),
      );
      await page
        .getByRole("button", { name: "Void invoice", exact: true })
        .click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await page.getByRole("alert").waitFor();
      assert.equal(
        await page.getByTestId("invoice-status").textContent(),
        "PENDING",
      );
      assert.equal(
        (await pool.query("SELECT status FROM invoices WHERE id=2")).rows[0]
          .status,
        "PENDING",
      );
    } finally {
      await browser.close();
    }
    const before = await snapshot(pool);
    const bad = structuredClone(before);
    bad.customers[1].name = "Unexpected";
    assert.throws(() =>
      verifyChange(before, bad, "invoices", 1, { status: "VOID" }),
    );
    assert.equal((await request("/logout", "POST")).status, 204);
    assert.equal((await request("/session")).status, 401);
  } finally {
    await server.close();
    await pool.end();
  }
});
test("database failure produces an actionable API error", async () => {
  const pool = createPool();
  await pool.end();
  const server = await startServer(pool, 0);
  try {
    const response = await fetch(server.url + "/api/health");
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /PostgreSQL/);
  } finally {
    await server.close();
  }
});

test("failed harness assertions save evidence and release owned resources", async () => {
  const { run } = await import("../src/harness/runner.js");
  const { tasks } = await import("../src/harness/tasks.js");
  const { readdir, readFile, access } = await import("node:fs/promises");
  const failedTask = {
    ...tasks[0]!,
    id: "intentional-failure",
    assert: () =>
      assert.fail("Forced assertion failure for evidence validation"),
  };
  await assert.rejects(run([failedTask]), /Evaluation failed/);
  const dirs = await readdir("artifacts");
  const matching = dirs.filter((d) => d.startsWith("intentional-failure-"));
  const directory = matching.at(-1)!;
  const report = JSON.parse(
    await readFile(`artifacts/${directory}/result.json`, "utf8"),
  );
  assert.equal(report.passed, false);
  assert.equal(report.category, "assertion");
  await access(`artifacts/${directory}/trace.zip`);
  await access(`artifacts/${directory}/final.png`);
  const serverEvent = report.events.find((event: string) =>
    event.includes("HTTP"),
  );
  assert.ok(serverEvent);
  const pool = createPool();
  try {
    const result = await pool.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
    );
    assert.equal(result.rows[0].count, 0);
  } finally {
    await pool.end();
  }
});
