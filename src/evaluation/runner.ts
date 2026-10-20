import { and, desc, eq, ne } from "drizzle-orm";
import { config } from "../config.js";
import { withTenantTx } from "../db/index.js";
import {
  evalDatasets,
  evalQueries,
  evalRunResults,
  evalRuns,
  type EvalMetrics,
} from "../db/schema/eval.js";
import { generateAnswer } from "../application/query.js";
import { retrieveEvidence } from "../retrieval/retriever.js";
import { runQueryIntelligence } from "../query/index.js";
import {
  averageMetrics,
  contextPrecision,
  contextRecall,
  evaluateRetrieval,
} from "./metrics.js";
import { getGenerationJudge } from "./judge.js";
import { checkRegression, renderReport } from "./regression.js";

/**
 * 评估运行器（§22.1 Regression Pipeline）：
 * Query → Retrieve → Generate → 指标打分 → 写报告 → 与基线对比。
 * 检索与生成在事务外执行（外部依赖），落库用 tenant 事务保证一致性。
 */

export interface EvalRunOptions {
  topK?: number;
  baselineTolerance?: number;
  /** 关闭 Reranker 重排（自优化 Agent 调参用）；缺省保持默认开启 */
  rerankerEnabled?: boolean;
  /** 走 Query Intelligence 链路（Rewrite / Multi Query / HyDE）；缺省关闭，保持既有评估语义 */
  intelligence?: boolean;
  /** Multi Query 变体数（intelligence 开启时生效，缺省用全局配置） */
  multiQueryCount?: number;
}

export interface EvalRunSummary {
  runId: string;
  datasetId: string;
  status: "ready" | "failed";
  metrics: EvalMetrics;
  baselineRunId: string | null;
  regressedMetrics: string[];
  gatePassed: boolean;
  report: string;
}

interface PerQueryResult {
  queryId: string;
  query: string;
  goldChunkIds: string[];
  retrievedChunkIds: string[];
  metrics: EvalMetrics;
  answer: string;
}

export async function runEvaluation(
  tenantId: string,
  datasetId: string,
  opts: EvalRunOptions = {},
): Promise<EvalRunSummary> {
  const topK = opts.topK ?? config.defaultTopK;
  const tolerance = opts.baselineTolerance ?? config.evalBaselineTolerance;

  const [datasetRow] = await withTenantTx(tenantId, (tx) =>
    tx
      .select()
      .from(evalDatasets)
      .where(eq(evalDatasets.id, datasetId))
      .limit(1),
  );
  if (!datasetRow) throw new Error(`eval dataset not found: ${datasetId}`);

  const queries = await withTenantTx(tenantId, (tx) =>
    tx
      .select()
      .from(evalQueries)
      .where(eq(evalQueries.datasetId, datasetId)),
  );
  if (queries.length === 0) throw new Error("eval dataset has no queries");

  const [runRow] = await withTenantTx(tenantId, (tx) =>
    tx
      .insert(evalRuns)
      .values({
        tenantId,
        datasetId,
        indexVersion: datasetRow.indexVersion,
        embeddingVersion: datasetRow.embeddingVersion,
        embeddingModel: config.embedding.model,
        topK,
        llmModel: config.openai.apiKey ? config.openai.model : null,
        reranker:
          opts.rerankerEnabled === false
            ? "off"
            : config.openai.apiKey
              ? "llm"
              : "lexical",
        status: "running",
      })
      .returning(),
  );
  const runId = runRow!.id;

  const judge = getGenerationJudge();
  const results: PerQueryResult[] = [];

  try {
    for (const q of queries) {
      // 检索链路：默认直连混合检索（与既有评估语义一致）；
      // opts.intelligence=true 时走 Query Intelligence（Rewrite / Multi Query / HyDE），
      // 供自优化 Agent 评估查询改写类参数
      const evidence = opts.intelligence
        ? (
            await runQueryIntelligence(tenantId, q.query, topK, undefined, {
              multiQueryCount: opts.multiQueryCount,
            })
          ).evidence
        : await retrieveEvidence(tenantId, q.query, topK, {
            useReranker: opts.rerankerEnabled,
          });
      const retrieved = evidence.map((e) => e.chunkId);
      const retMetrics = evaluateRetrieval(q.goldChunkIds, retrieved, topK);
      const answer = await generateAnswer(q.query, evidence);
      const ctxText = evidence.map((e) => e.content).join("\n");
      const faithfulness = await judge.faithfulness(answer, {
        text: ctxText,
        evidenceCount: evidence.length,
      });
      const answerRelevance = await judge.answerRelevance(q.query, answer);

      results.push({
        queryId: q.id,
        query: q.query,
        goldChunkIds: q.goldChunkIds,
        retrievedChunkIds: retrieved,
        metrics: {
          ...retMetrics,
          contextPrecision: contextPrecision(q.goldChunkIds, retrieved),
          contextRecall: contextRecall(q.goldChunkIds, retrieved),
          faithfulness,
          answerRelevance,
        },
        answer,
      });
    }

    const summary = averageMetrics(results);

    // 基线 = 同一 dataset 最近一次 ready 的运行（排除本次运行）
    const [baselineRow] = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(evalRuns)
        .where(
          and(eq(evalRuns.datasetId, datasetId), ne(evalRuns.id, runId)),
        )
        .orderBy(desc(evalRuns.createdAt))
        .limit(1),
    );
    const baseline =
      baselineRow && baselineRow.status === "ready" ? baselineRow : null;

    const check = checkRegression(summary, baseline?.metrics ?? null, tolerance);

    const report = renderReport({
      runId,
      datasetName: datasetRow.name,
      indexVersion: datasetRow.indexVersion,
      embeddingVersion: datasetRow.embeddingVersion,
      topK,
      llmModel: config.openai.apiKey ? config.openai.model : null,
      reranker: config.openai.apiKey ? "llm" : "lexical",
      metrics: summary,
      baseline: baseline
        ? { runId: baseline.id, metrics: baseline.metrics }
        : null,
      check,
      rows: results.map((r) => ({
        query: r.query,
        metrics: r.metrics,
        answer: r.answer,
      })),
    });

    await withTenantTx(tenantId, async (tx) => {
      await tx
        .insert(evalRunResults)
        .values(
          results.map((r) => ({
            tenantId,
            runId,
            queryId: r.queryId,
            query: r.query,
            goldChunkIds: r.goldChunkIds,
            retrievedChunkIds: r.retrievedChunkIds,
            metrics: r.metrics,
            answer: r.answer,
          })),
        );
      await tx
        .update(evalRuns)
        .set({
          status: "ready",
          metrics: summary,
          report,
          baselineRunId: baseline?.id ?? null,
          regressedMetrics: check.regressedMetrics,
          gatePassed: check.gatePassed,
        })
        .where(eq(evalRuns.id, runId));
    });

    return {
      runId,
      datasetId,
      status: "ready",
      metrics: summary,
      baselineRunId: baseline?.id ?? null,
      regressedMetrics: check.regressedMetrics,
      gatePassed: check.gatePassed,
      report,
    };
  } catch (err) {
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(evalRuns)
        .set({ status: "failed", error: (err as Error).message })
        .where(eq(evalRuns.id, runId)),
    ).catch(() => undefined);
    throw err;
  }
}
