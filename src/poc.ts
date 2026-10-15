import { run } from "./harness/runner.js";
import { tasks } from "./harness/tasks.js";
run([tasks[0]!], process.argv.includes("--headed")).catch((error) => {
  console.error("❌ TraceBench PoC failed:", error);
  process.exitCode = 1;
});
