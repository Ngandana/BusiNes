// Runs every check and stops at the first failure.
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const here = fileURLToPath(new URL(".", import.meta.url));
for (const f of ["migrate.mjs", "features.mjs", "app.mjs"]) {
  console.log(`\n================ ${f} ================`);
  const r = spawnSync(process.execPath, [here + f], { stdio: "inherit" });
  if (r.status !== 0) { console.log(`\nFAILED in ${f}`); process.exit(1); }
}
console.log("\nAll checks passed.");
