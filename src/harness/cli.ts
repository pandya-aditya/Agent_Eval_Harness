import { run } from "./runner.js";
run(undefined, process.argv.includes("--headed")).catch((error) => {
  console.error("❌ Evaluation failed:", error);
  process.exitCode = 1;
});
