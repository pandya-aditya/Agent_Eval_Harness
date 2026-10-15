import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { Pool } from "pg";
import { seed, snapshot } from "../app/db.js";
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
export interface Task {
  id: string;
  instruction: string;
  seed: (pool: Pool) => Promise<void>;
  action: (page: Page, log: (message: string) => void) => Promise<void>;
  assert: (before: Snapshot, after: Snapshot) => void;
}
export function verifyChange(
  before: Snapshot,
  after: Snapshot,
  kind: "invoices" | "customers",
  id: number,
  changes: Record<string, unknown>,
) {
  const expected = structuredClone(before);
  const record = expected[kind].find((r) => r.id === id);
  assert.ok(record, "Target fixture must exist");
  Object.assign(record, changes);
  assert.deepEqual(
    after,
    expected,
    "Expected target changes only; every unrelated record and field must remain unchanged",
  );
}
const invoiceTask = (
  number: string,
  id: number,
  action: "void" | "pay",
  status: string,
): Task => ({
  id: `${action}-${number}`,
  instruction: `${action === "void" ? "Void" : "Mark paid"} invoice #${number}.`,
  seed,
  action: async (page, log) => {
    log(`Open invoice #${number}`);
    await page
      .getByRole("link", { name: `Invoice #${number}`, exact: true })
      .click();
    await page.getByTestId("invoice-status").waitFor();
    log(
      `Click ${action === "void" ? "Void invoice" : "Mark paid"} and confirm`,
    );
    await page
      .getByRole("button", {
        name: action === "void" ? "Void invoice" : "Mark paid",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Invoice updated." })
      .waitFor();
    assert.equal(
      await page.getByTestId("invoice-status").textContent(),
      status,
    );
    log("Refresh to verify persisted UI state");
    await page.reload();
    await page.getByTestId("invoice-status").waitFor();
    assert.equal(
      await page.getByTestId("invoice-status").textContent(),
      status,
    );
  },
  assert: (before, after) =>
    verifyChange(before, after, "invoices", id, { status }),
});
export const tasks: Task[] = [
  invoiceTask("1042", 1, "void", "VOID"),
  invoiceTask("1043", 2, "pay", "PAID"),
  {
    id: "edit-customer",
    instruction:
      "Change Northstar Studio billing email to finance@northstar.example and billing address to 99 Front Street, Toronto.",
    seed,
    action: async (page, log) => {
      log("Open Northstar Studio customer record");
      await page
        .getByRole("link", { name: "Northstar Studio", exact: true })
        .first()
        .click();
      await page.getByLabel("Billing email").fill("finance@northstar.example");
      await page.getByLabel("Billing address").fill("99 Front Street, Toronto");
      log("Save billing details");
      await page.getByRole("button", { name: "Save billing details" }).click();
      await page
        .getByRole("status")
        .filter({ hasText: "Billing details saved." })
        .waitFor();
      await page.reload();
      await page.getByLabel("Billing email").waitFor();
      assert.equal(
        await page.getByLabel("Billing email").inputValue(),
        "finance@northstar.example",
      );
      assert.equal(
        await page.getByLabel("Billing address").inputValue(),
        "99 Front Street, Toronto",
      );
    },
    assert: (before, after) =>
      verifyChange(before, after, "customers", 1, {
        billing_email: "finance@northstar.example",
        billing_address: "99 Front Street, Toronto",
      }),
  },
];
