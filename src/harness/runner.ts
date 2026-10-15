import { chromium, type Browser, type BrowserContext } from "playwright";
import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AssertionError } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPool,
  migrate,
  snapshot,
  DEMO_EMAIL,
  DEMO_PASSWORD,
} from "../app/db.js";
import { startServer } from "../app/server.js";
import { tasks, type Task } from "./tasks.js";
export async function login(
  page: import("playwright").Page,
  log: (message: string) => void,
) {
  log("Sign in through the UI as the seeded demo user");
  await page.getByLabel("Email", { exact: true }).fill(DEMO_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Invoices", exact: true }).waitFor();
}
export async function run(selected: Task[] = tasks, headed = false) {
  const started = Date.now();
  const log = (s: string) =>
    console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${s}`);
  log(
    "🚀 Billing Desk evaluation: scripted Playwright baseline; no AI agent involved.",
  );
  log(
    "🗄️ Each task resets invoices, customers, and demo users in the configured benchmark database.",
  );
  const pool = createPool();
  let browser: Browser | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let failed = false;
  try {
    try {
      await access(resolve("dist/web/index.html"));
    } catch {
      log("Building the real React application");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("npm", ["run", "build"], { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Build exited ${code}`)),
        );
      });
    }
    const deadline = Date.now() + 30000;
    while (true) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        log("Waiting for PostgreSQL…");
        await delay(1000);
      }
    }
    await migrate(pool);
    server = await startServer(pool, 0);
    log(`🌐 Owned application server ready: ${server.url}`);
    browser = await chromium.launch({
      headless: !headed,
      slowMo: headed ? 350 : 0,
    });
    for (const task of selected) {
      const runId = `${task.id}-${randomUUID()}`;
      const directory = resolve("artifacts", runId);
      await mkdir(directory, { recursive: true });
      let context: BrowserContext | undefined;
      let stage = "database";
      let error: unknown;
      let category = "";
      const events: string[] = [];
      const taskLog = (s: string) => {
        events.push(s);
        log(`[${runId}] ${s}`);
      };
      try {
        taskLog(`Task: ${task.instruction}`);
        await task.seed(pool);
        const before = await snapshot(pool);
        taskLog(
          `Initial state: ${JSON.stringify({ invoices: before.invoices, customers: before.customers })}`,
        );
        stage = "browser";
        context = await browser.newContext({
          extraHTTPHeaders: { "x-tracebench-run-id": runId },
        });
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.on("response", (response) => {
          if (new URL(response.url()).pathname.startsWith("/api"))
            taskLog(
              `HTTP ${response.request().method()} ${new URL(response.url()).pathname} → ${response.status()}`,
            );
        });
        await page.goto(server.url);
        await login(page, taskLog);
        await task.action(page, taskLog);
        stage = "database";
        taskLog(
          "SQL verification: SELECT * FROM invoices/customers/users ORDER BY id (user hashes omitted from output).",
        );
        const after = await snapshot(pool);
        taskLog(
          `Observed state: ${JSON.stringify({ invoices: after.invoices, customers: after.customers })}`,
        );
        stage = "assertion";
        taskLog(
          `Expected: ${task.instruction} All other records and fields unchanged.`,
        );
        task.assert(before, after);
        taskLog("✅ Target state and unchanged-record assertions passed.");
      } catch (caught) {
        error = caught;
        failed = true;
        category = caught instanceof AssertionError ? "assertion" : stage;
        taskLog(
          `❌ ${category} failure: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      } finally {
        if (context) {
          try {
            const page = context.pages()[0];
            if (page)
              await page.screenshot({
                path: resolve(directory, "final.png"),
                fullPage: true,
              });
          } catch (caught) {
            taskLog(`Screenshot unavailable: ${String(caught)}`);
          }
          try {
            await context.tracing.stop(
              error ? { path: resolve(directory, "trace.zip") } : {},
            );
          } catch (caught) {
            error ??= caught;
            category ||= "browser";
            failed = true;
          } finally {
            try {
              await context.close();
            } catch (caught) {
              error ??= caught;
              category ||= "browser";
              failed = true;
            }
          }
        }
        await writeFile(
          resolve(directory, "result.json"),
          JSON.stringify(
            {
              runId,
              task: task.id,
              instruction: task.instruction,
              passed: !error,
              category: error ? category : undefined,
              error:
                error instanceof Error
                  ? error.message
                  : error
                    ? String(error)
                    : undefined,
              events,
            },
            null,
            2,
          ),
        );
        taskLog(`Evidence saved: ${directory}`);
      }
    }
  } finally {
    const cleanup = await Promise.allSettled([
      browser?.close(),
      server?.close(),
    ]);
    await pool.end();
    for (const result of cleanup)
      if (result.status === "rejected") throw result.reason;
    log("🧹 Owned server, browser, and database pool closed.");
  }
  if (failed)
    throw new Error(
      "Evaluation failed. Inspect artifacts/*/result.json and failure traces.",
    );
  console.log("🎉 SUCCESS: PoC passed!");
}
