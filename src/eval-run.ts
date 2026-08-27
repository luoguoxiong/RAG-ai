import { pool } from "./db/index.js";
import { runEvaluation } from "./evaluation/runner.js";

const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * 评估回归 CLI（§22.1 CI gate）：
 * 用法：pnpm eval:run --dataset <id> [--topK n] [--tenant <id>]
 * 检测到指标回退时以非 0 退出码结束，可挂到 CI 阻断合并。
 */
function parseArgs(argv: string[]): {
  tenantId: string;
  datasetId: string;
  topK?: number;
} {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = "true";
    }
  }
  const datasetId = args["dataset"] ?? "";
  if (!datasetId) {
    throw new Error(
      "usage: tsx src/eval-run.ts --dataset <id> [--topK n] [--tenant <id>]",
    );
  }
  return {
    tenantId: args["tenant"] ?? DEMO_TENANT_ID,
    datasetId,
    topK: args["topK"] ? Number(args["topK"]) : undefined,
  };
}

async function main(): Promise<void> {
  await pool.query("select 1");
  const { tenantId, datasetId, topK } = parseArgs(process.argv.slice(2));
  const summary = await runEvaluation(tenantId, datasetId, { topK });

  console.log(
    `[eval] run ${summary.runId} status=${summary.status} gatePassed=${summary.gatePassed}`,
  );
  console.log(JSON.stringify(summary.metrics, null, 2));
  console.log(
    summary.regressedMetrics.length
      ? `[eval] regressed: ${summary.regressedMetrics.join(", ")}`
      : "[eval] no regression",
  );

  await pool.end();
  // CI gate：存在回退指标时非 0 退出，阻断合并
  if (summary.regressedMetrics.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
