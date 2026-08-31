import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Loader2, Play, Plus } from "lucide-react";
import { api } from "../../api/client";
import type { EvalMetrics, EvalRun, EvalRunResult } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";

const METRIC_LABELS: Record<keyof EvalMetrics, string> = {
  recallAtK: "Recall@K",
  hitRate: "Hit Rate",
  mrr: "MRR",
  ndcg: "NDCG",
  contextPrecision: "Ctx Precision",
  contextRecall: "Ctx Recall",
  faithfulness: "Faithfulness",
  answerRelevance: "Answer Relevance",
};

const METRIC_KEYS = Object.keys(METRIC_LABELS) as (keyof EvalMetrics)[];

/** 指标值染色：>=0.7 绿、>=0.4 黄、否则红 */
function metricColor(v: number): string {
  if (v >= 0.7) return "bg-green-100 text-green-700";
  if (v >= 0.4) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
}

function MetricsBar({ metrics }: { metrics: Partial<EvalMetrics> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {METRIC_KEYS.map((k) => {
        const v = metrics[k];
        return (
          <Badge
            key={k}
            className={
              v != null
                ? metricColor(v)
                : "bg-zinc-100 text-zinc-400"
            }
          >
            {METRIC_LABELS[k]} {v != null ? v.toFixed(3) : "—"}
          </Badge>
        );
      })}
    </div>
  );
}

const QUERIES_PLACEHOLDER = `[
  {
    "query": "什么是 RAG？",
    "goldChunkIds": ["chunk-uuid-1"],
    "referenceAnswer": "RAG 是检索增强生成",
    "keyFacts": ["结合检索与生成"]
  }
]`;

export default function EvalPage() {
  const qc = useQueryClient();

  // ── 创建评估集 ─────────────────────────────────────────
  const [dsName, setDsName] = useState("");
  const [dsDesc, setDsDesc] = useState("");
  const [queriesJson, setQueriesJson] = useState("");

  // ── 运行评估 ─────────────────────────────────────────
  const [selectedDsId, setSelectedDsId] = useState("");
  const [topK, setTopK] = useState(6);

  // ── 运行详情 ─────────────────────────────────────────
  const [selectedRunId, setSelectedRunId] = useState("");

  const datasets = useQuery({
    queryKey: ["eval-datasets"],
    queryFn: api.listEvalDatasets,
  });

  const runs = useQuery({
    queryKey: ["eval-runs"],
    queryFn: api.listEvalRuns,
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === "running") ? 3000 : false,
  });

  const runDetail = useQuery({
    queryKey: ["eval-run", selectedRunId],
    queryFn: () => api.getEvalRunDetail(selectedRunId),
    enabled: !!selectedRunId,
  });

  const report = useQuery({
    queryKey: ["eval-report", selectedRunId],
    queryFn: () => api.getEvalReport(selectedRunId),
    enabled: !!selectedRunId,
  });

  const createDataset = useMutation({
    mutationFn: () => {
      let queries;
      try {
        queries = JSON.parse(queriesJson || "[]");
      } catch {
        throw new Error("queries JSON 格式错误");
      }
      return api.createEvalDataset({
        name: dsName,
        description: dsDesc || undefined,
        queries,
      });
    },
    onSuccess: () => {
      setDsName("");
      setDsDesc("");
      setQueriesJson("");
      qc.invalidateQueries({ queryKey: ["eval-datasets"] });
    },
  });

  const runEval = useMutation({
    mutationFn: () => {
      if (!selectedDsId) throw new Error("请先选择评估集");
      return api.runEvaluation({ datasetId: selectedDsId, topK });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["eval-runs"] });
    },
  });

  const dsList = datasets.data ?? [];
  const runList = runs.data ?? [];
  const detail = runDetail.data;
  const reportText = report.data;

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="border-b bg-white px-6 py-4">
        <h1 className="text-lg font-semibold">评估面板</h1>
        <p className="text-sm text-zinc-500">
          建评估集 → 跑评估 → 看回归报告（8 项指标 + 基线对比门禁）
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-2">
        {/* ── 左列：创建评估集 + 评估集列表 ── */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>创建评估集</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                placeholder="名称，如 baseline-v1"
                value={dsName}
                onChange={(e) => setDsName(e.target.value)}
              />
              <Input
                placeholder="描述（可选）"
                value={dsDesc}
                onChange={(e) => setDsDesc(e.target.value)}
              />
              <Textarea
                placeholder={QUERIES_PLACEHOLDER}
                value={queriesJson}
                onChange={(e) => setQueriesJson(e.target.value)}
                className="min-h-[140px] font-mono text-xs"
              />
              <Button
                onClick={() => createDataset.mutate()}
                disabled={!dsName.trim() || !queriesJson.trim() || createDataset.isPending}
              >
                {createDataset.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                创建
              </Button>
              {createDataset.isError && (
                <p className="text-sm text-red-600">
                  {(createDataset.error as Error).message}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>评估集列表（{dsList.length}）</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {dsList.map((d) => (
                  <li
                    key={d.id}
                    className={`flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors ${
                      selectedDsId === d.id
                        ? "border-zinc-900 bg-zinc-50"
                        : "hover:bg-zinc-50"
                    }`}
                    onClick={() => setSelectedDsId(d.id)}
                  >
                    <div className="min-w-0">
                      <span className="font-medium">{d.name}</span>
                      {d.description && (
                        <span className="ml-2 text-xs text-zinc-400">
                          {d.description}
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-zinc-400">
      idx:{d.indexVersion} emb:{d.embeddingVersion}
                    </span>
                  </li>
                ))}
                {dsList.length === 0 && (
                  <li className="py-4 text-center text-sm text-zinc-400">
                    暂无评估集
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </div>

        {/* ── 右列：运行评估 + 运行记录 ── */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>运行评估</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-sm text-zinc-600">评估集</span>
                <span className="flex-1 truncate rounded-md border bg-zinc-50 px-3 py-1.5 text-sm">
                  {dsList.find((d) => d.id === selectedDsId)?.name ??
                    "（未选择）"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-sm text-zinc-600">topK</label>
                <Input
                  type="number"
                  min={1}
                  value={topK}
                  onChange={(e) => setTopK(Number(e.target.value))}
                  className="h-8 w-24"
                />
                <Button
                  onClick={() => runEval.mutate()}
                  disabled={!selectedDsId || runEval.isPending}
                >
                  {runEval.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  运行
                </Button>
              </div>
              {runEval.isError && (
                <p className="text-sm text-red-600">
                  {(runEval.error as Error).message}
                </p>
              )}
              {runEval.isSuccess && (
                <div className="space-y-2 rounded-md border border-green-200 bg-green-50 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-green-700">
                    <ClipboardCheck className="h-4 w-4" />
                    {runEval.data.gatePassed ? "门禁通过" : "门禁未通过"}
                  </div>
                  <MetricsBar metrics={runEval.data.metrics} />
                  {runEval.data.regressedMetrics.length > 0 && (
                    <p className="text-xs text-red-600">
                      回归指标：{runEval.data.regressedMetrics.join(", ")}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>运行记录（{runList.length}）</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {runList.map((r: EvalRun) => (
                  <li
                    key={r.id}
                    className={`cursor-pointer rounded-md border px-3 py-2 text-sm transition-colors ${
                      selectedRunId === r.id
                        ? "border-zinc-900 bg-zinc-50"
                        : "hover:bg-zinc-50"
                    }`}
                    onClick={() => setSelectedRunId(r.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge
                          className={
                            r.status === "ready"
                              ? "bg-green-100 text-green-700"
                              : r.status === "running"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-red-100 text-red-700"
                          }
                        >
                          {r.status}
                        </Badge>
                        {r.gatePassed != null && (
                          <Badge
                            className={
                              r.gatePassed
                                ? "bg-green-100 text-green-700"
                                : "bg-red-100 text-red-700"
                            }
                          >
                            {r.gatePassed ? "PASS" : "FAIL"}
                          </Badge>
                        )}
                        <span className="text-xs text-zinc-400">
                          topK={r.topK}
                        </span>
                      </div>
                      <span className="text-xs text-zinc-400">
                        {new Date(r.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {r.status === "ready" &&
                      Object.keys(r.metrics).length > 0 && (
                        <div className="mt-1.5">
                          <MetricsBar metrics={r.metrics} />
                        </div>
                      )}
                    {r.regressedMetrics.length > 0 && (
                      <p className="mt-1 text-xs text-red-600">
                        回归：{r.regressedMetrics.join(", ")}
                      </p>
                    )}
                  </li>
                ))}
                {runList.length === 0 && (
                  <li className="py-4 text-center text-sm text-zinc-400">
                    暂无运行记录
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── 运行详情（全宽） ── */}
      {detail && (
        <div className="border-t bg-zinc-50 p-6">
          <div className="mx-auto max-w-4xl space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">运行详情</h2>
              <span className="text-xs text-zinc-400">
                {detail.run.embeddingModel ?? "deterministic"} ·{" "}
                {detail.run.reranker ?? "none"}
                {detail.run.llmModel ? ` · ${detail.run.llmModel}` : ""}
              </span>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>汇总指标</CardTitle>
              </CardHeader>
              <CardContent>
                <MetricsBar metrics={detail.run.metrics} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>逐查询结果（{detail.results.length}）</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {detail.results.map((r: EvalRunResult, i) => (
                    <div
                      key={r.id}
                      className="rounded-md border p-3 text-sm"
                    >
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 font-medium text-zinc-400">
                          #{i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{r.query}</p>
                          <div className="mt-1">
                            <MetricsBar metrics={r.metrics} />
                          </div>
                          {r.answer && (
                            <p className="mt-2 whitespace-pre-wrap text-zinc-600">
                              {r.answer}
                            </p>
                          )}
                          <div className="mt-2 flex gap-4 text-xs text-zinc-400">
                            <span>
                              gold: {r.goldChunkIds.length} 个
                            </span>
                            <span>
                              retrieved: {r.retrievedChunkIds.length} 个
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {reportText && (
              <Card>
                <CardHeader>
                  <CardTitle>回归报告</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-zinc-700">
                    {reportText}
                  </pre>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
