# TraceBench · Billing Desk

A local evaluation harness for stateful web applications. The included Billing Desk app has a real React UI, an Express API, demo authentication, and PostgreSQL persistence.

**Reset fixtures → log in through the browser → complete a task → query PostgreSQL independently.**

The baseline uses scripted Playwright actions. It does not yet evaluate an AI agent. Unlike the original mock PoC, the harness never executes the status/customer update being tested: the application API performs it in response to browser requests.

## Setup

Requires Node.js 22.12 or newer, npm, and Docker Compose. Start your Docker daemon, then:

```sh
npm install
npx playwright install chromium
docker compose up -d
npm run migrate
npm run seed
```

On Linux, install browser system libraries with `npx playwright install --with-deps chromium` if needed.

PostgreSQL 15 uses `postgres://postgres:postgres@localhost:5432/tracebench_dev`.
Override `DATABASE_URL` in your environment or `.env`. **Seed, evaluation, and integration-test commands reset invoices, customers, and users. Use only a dedicated benchmark database.** Concurrent evaluations/tests against the same database are unsupported.

## Explore the application

```sh
npm run dev
```

Open the Vite URL printed in your terminal (normally `http://127.0.0.1:5173`). The API listens on `127.0.0.1:3001`; Vite proxies `/api` to it. Both servers shut down together when you press Ctrl+C. Application startup never resets data or runs migrations.

Demo login:

- Email: `demo@tracebench.local`
- Password: `tracebench-demo`

View the four invoices, open an invoice, and confirm “Void invoice” or “Mark paid.” Only pending invoices can change status; paid and void invoices are final. “Mark paid” records status only and processes no money. Click a customer name to edit its billing email/address. Refresh to verify the changes persist.

For a built application served by Express:

```sh
npm run build
npm start
```

Open `http://127.0.0.1:3001`. `PORT` overrides the Express port outside development mode. Demo sessions last eight hours and reset when the backend restarts. This local single-workspace app has no external authentication or payment services.

## Evaluate the application

Run the original invoice-void scenario:

```sh
npx tsx src/poc.ts
npx tsx src/poc.ts --headed
```

Run all three tasks:

```sh
npm run eval
npm run eval -- --headed
```

The evaluator builds the UI if necessary (the suite command always rebuilds), waits up to 30 seconds for PostgreSQL, applies migrations, and starts its own app server on a free localhost port. Each task resets fixtures and gets a new browser context, then signs in through the UI. It closes its browser, server, and database pool afterward. The existing standalone development server is not used.

| Task                   | Expected database change                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Void invoice 1042      | Invoice 1 status becomes `VOID`                                                               |
| Mark invoice 1043 paid | Invoice 2 status becomes `PAID`                                                               |
| Edit Northstar Studio  | Billing email becomes `finance@northstar.example`; address becomes `99 Front Street, Toronto` |

Every task refreshes the UI to check persistence and compares complete database snapshots. All unrelated records and fields—including the other customer and invoices—must remain unchanged. The demo user's password hash is included in internal comparisons but omitted from evidence output.

Terminal narration explains instructions, starting state, browser actions, HTTP outcomes, SQL reads, expected/actual values, and cleanup. Backend logs share a run ID and report request method/path, operation, affected rows, duration, and HTTP status. They omit credentials and customer billing values. The evaluator's evidence intentionally includes the synthetic billing fixture values.

Artifacts are saved under `artifacts/<task>-<run-id>/`:

- `result.json`: instruction, outcome, failure category, and narrated events.
- `final.png`: final browser screenshot, when a page is available.
- `trace.zip`: browser trace on failure; inspect with `npx playwright show-trace artifacts/<run-id>/trace.zip`.

Failures are classified as assertion, browser, or database errors. Startup failures print their error and exit nonzero. Any failed task causes a nonzero suite exit; successful runs end with `🎉 SUCCESS: PoC passed!`.

## Development and validation

```sh
npm run typecheck
npm test
```

Integration tests use the configured PostgreSQL database and Chromium. They verify migration of the old PoC schema, authentication, API validation, concurrent status changes, cancellation, failed UI requests, unchanged-record checks, and database-error responses. Migration compatibility is tested in a temporary schema that is removed afterward.

Database migrations are versioned and transactional. Existing PoC invoices retain their numbers/statuses and appear with an unassigned customer and zero amount until an explicit fixture reset. Duplicate/missing invoice numbers or invalid existing statuses cause migration to fail and roll back rather than silently discard records.

The task interface lives in `src/harness/tasks.ts`: task ID, instruction, seed function, browser action, and database assertion. This is the extension point for future tasks and agent integrations.

Stop PostgreSQL with `docker compose down`. Data remains in its Docker volume; `docker compose down -v` deletes that development data.
