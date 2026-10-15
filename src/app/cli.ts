import { createPool, migrate, seed, DEMO_EMAIL, DEMO_PASSWORD } from "./db.js";
import { startServer } from "./server.js";
const pool = createPool();
async function main() {
  const command = process.argv[2];
  if (command === "migrate") {
    await migrate(pool);
    console.log("Database migrations complete.");
    await pool.end();
  } else if (command === "seed") {
    console.log("Resetting dedicated benchmark database fixtures.");
    await migrate(pool);
    await seed(pool);
    console.log(`Demo user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    await pool.end();
  } else {
    const server = await startServer(pool, Number(process.env.PORT ?? 3001));
    console.log(`Billing Desk API: ${server.url}`);
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      await server.close();
      await pool.end();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  }
}
main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});
