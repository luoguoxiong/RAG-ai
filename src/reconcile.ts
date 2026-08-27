import { pool } from "./db/index.js";
import { runReconcile } from "./application/reconcile.js";

async function main(): Promise<void> {
  await pool.query("select 1");
  const stats = await runReconcile();
  console.log("[reconcile] done", stats);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});