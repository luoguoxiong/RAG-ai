import { pool } from "./db/index.js";
import { runBadcaseDiagnosis } from "./agent/diagnosis.js";
import { runAutoTuning } from "./agent/optimizer.js";
import { assessDataset } from "./agent/assessment.js";

const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * RAG 自优化 Agent CLI：
 * - 诊断：pnpm agent:diagnose [--days 7] [--limit 200] [--no-llm] [--tenant <id>]
 * - 调优：pnpm agent:tune --dataset <id> [--days 7] [--max-experiments 6]
 *          [--primary recallAtK] [--no-llm-plan] [--tenant <id>]
 * - 测评：pnpm agent:assess --dataset <id> [--topK 6] | --run <evalRunId> [--tenant <id>]
 * 三者均把完整 Markdown 报告输出到终端，报告同时落库可通过 API 获取。
 */
function parseArgs(argv: string[]): Record<string, string> {
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
  return args;
}

async function main(): Promise<void> {
  await pool.query("select 1");
  const [mode] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(3));
  const tenantId = args["tenant"] ?? DEMO_TENANT_ID;

  if (mode === "diagnose") {
    const summary = await runBadcaseDiagnosis(tenantId, {
      sinceDays: args["days"] ? Number(args["days"]) : undefined,
      limit: args["limit"] ? Number(args["limit"]) : undefined,
      useLLM: args["no-llm"] ? false : undefined,
    });
    console.log(
      `[agent] diagnosis ${summary.diagnosisId} status=${summary.status} samples=${summary.sampleCount} badcases=${summary.badcaseCount} health=${summary.healthScore}`,
    );
    console.log("[agent] issue stats:", JSON.stringify(summary.issueStats));
    console.log("\n" + summary.report);
  } else if (mode === "tune") {
    const datasetId = args["dataset"] ?? "";
    if (!datasetId) {
      throw new Error(
        "usage: tsx src/agent-run.ts tune --dataset <id> [--days 7] [--max-experiments 6] [--primary recallAtK] [--no-llm-plan] [--tenant <id>]",
      );
    }
    const summary = await runAutoTuning(tenantId, {
      datasetId,
      sinceDays: args["days"] ? Number(args["days"]) : undefined,
      maxExperiments: args["max-experiments"]
        ? Number(args["max-experiments"])
        : undefined,
      primaryMetric: args["primary"],
      useLLMPlan: args["no-llm-plan"] ? false : undefined,
    });
    console.log(
      `[agent] tuning ${summary.tuningRunId} status=${summary.status} experiments=${summary.totalExperiments} gatePassed=${summary.gatePassedCount}`,
    );
    console.log("[agent] hypothesis:", summary.hypothesis);
    console.log(
      `[agent] baseline utility=${summary.baseline?.utility} best=${
        summary.best ? `${JSON.stringify(summary.best.config)} utility=${summary.best.utility}` : "none"
      }`,
    );
    console.log("[agent] deltas:", JSON.stringify(summary.deltas));
    console.log("\n" + summary.report);
  } else if (mode === "assess") {
    const datasetId = args["dataset"];
    const evalRunId = args["run"];
    if (!datasetId && !evalRunId) {
      throw new Error(
        "usage: tsx src/agent-run.ts assess --dataset <id> [--topK 6] | --run <evalRunId> [--tenant <id>]",
      );
    }
    const summary = await assessDataset(tenantId, {
      datasetId: datasetId || undefined,
      evalRunId: evalRunId || undefined,
      topK: args["topK"] ? Number(args["topK"]) : undefined,
    });
    console.log(
      `[agent] assessment ${summary.assessmentId} status=${summary.status} queries=${summary.queryCount} overall=${summary.overallScore} grade=${summary.grade ?? "-"}（${summary.gradeLabel ?? "-"}）`,
    );
    console.log("[agent] dimension scores:", JSON.stringify(summary.dimensionScores));
    console.log("[agent] problems:", JSON.stringify(summary.problemStats));
    console.log("\n" + summary.report);
  } else {
    throw new Error(
      `unknown mode: ${mode ?? "(empty)"}，用法：tsx src/agent-run.ts <diagnose|tune|assess> [options]`,
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
