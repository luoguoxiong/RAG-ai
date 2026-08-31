import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "../../api/client";
import type { RetrievalLog } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";

/** 耗时染色：<500ms 绿、<2000ms 黄、否则红 */
function latencyColor(ms: number | null): string {
  if (ms == null) return "bg-zinc-100 text-zinc-400";
  if (ms < 500) return "bg-green-100 text-green-700";
  if (ms < 2000) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
}

function formatMs(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function scoreColor(score: number | null): string {
  if (score == null) return "bg-zinc-100 text-zinc-400";
  if (score >= 0.7) return "bg-green-100 text-green-700";
  if (score >= 0.4) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
}

export default function HistoryPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const logs = useQuery({
    queryKey: ["retrieval-logs"],
    queryFn: api.listRetrievalLogs,
    refetchInterval: 5000,
  });

  const logList = logs.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="border-b bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-zinc-500" />
          <h1 className="text-lg font-semibold">检索历史</h1>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          每次检索的性能指标（最近 100 条，5 秒自动刷新）
        </p>
      </header>

      <div className="p-6">
        {logs.isPending && (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载中…
          </div>
        )}

        {logs.isError && (
          <p className="text-sm text-red-600">
            加载失败：{(logs.error as Error).message}
          </p>
        )}

        {logList.length === 0 && !logs.isPending && (
          <div className="flex h-64 items-center justify-center text-sm text-zinc-400">
            暂无检索记录，去检索问答页试试吧
          </div>
        )}

        {logList.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>检索记录（{logList.length}）</CardTitle>
            </CardHeader>
            <CardContent>
              {/* ── 汇总统计 ── */}
              <div className="mb-4 flex flex-wrap gap-4 text-sm">
                <span className="text-zinc-500">
                  平均耗时{" "}
                  <span className="font-medium text-zinc-700">
                    {formatMs(
                      logList.reduce((s, l) => s + (l.latencyMs ?? 0), 0) /
                        logList.length,
                    )}
                  </span>
                </span>
                <span className="text-zinc-500">
                  平均检索{" "}
                  <span className="font-medium text-zinc-700">
                    {formatMs(
                      logList.reduce((s, l) => s + (l.retrievalMs ?? 0), 0) /
                        logList.length,
                    )}
                  </span>
                </span>
                <span className="text-zinc-500">
                  平均生成{" "}
                  <span className="font-medium text-zinc-700">
                    {formatMs(
                      logList.reduce((s, l) => s + (l.generationMs ?? 0), 0) /
                        logList.length,
                    )}
                  </span>
                </span>
                <span className="text-zinc-500">
                  平均引用{" "}
                  <span className="font-medium text-zinc-700">
                    {(
                      logList.reduce((s, l) => s + l.citationCount, 0) /
                      logList.length
                    ).toFixed(1)}
                  </span>
                </span>
              </div>

              {/* 有 ground truth 的记录的检索质量指标平均 */}
              {(() => {
                const withGold = logList.filter((l) => l.recallAtK != null);
                if (withGold.length === 0) return null;
                const avg = (k: "recallAtK" | "hitRate" | "mrr" | "ndcg") =>
                  withGold.reduce((s, l) => s + (l[k] ?? 0), 0) /
                  withGold.length;
                return (
                  <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
                    <span className="text-xs text-zinc-400">
                      ground truth 记录（{withGold.length}）平均：
                    </span>
                    <span className="text-zinc-500">
                      召回率{" "}
                      <span className="font-medium text-zinc-700">
                        {avg("recallAtK").toFixed(3)}
                      </span>
                    </span>
                    <span className="text-zinc-500">
                      命中率{" "}
                      <span className="font-medium text-zinc-700">
                        {avg("hitRate").toFixed(3)}
                      </span>
                    </span>
                    <span className="text-zinc-500">
                      MRR{" "}
                      <span className="font-medium text-zinc-700">
                        {avg("mrr").toFixed(3)}
                      </span>
                    </span>
                    <span className="text-zinc-500">
                      NDCG{" "}
                      <span className="font-medium text-zinc-700">
                        {avg("ndcg").toFixed(3)}
                      </span>
                    </span>
                  </div>
                );
              })()}

              {/* ── 列表 ── */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-zinc-400">
                      <th className="py-2 pr-3 font-medium">时间</th>
                      <th className="py-2 pr-3 font-medium">查询</th>
                      <th className="py-2 pr-3 font-medium">参数</th>
                      <th className="py-2 pr-3 font-medium">引用</th>
                      <th className="py-2 pr-3 font-medium">最高分</th>
                      <th className="py-2 pr-3 font-medium" title="提供 gold ids 时计算，否则为 -">
                        Recall@K
                      </th>
                      <th className="py-2 pr-3 font-medium" title="提供 gold ids 时计算，否则为 -">
                        Hit Rate
                      </th>
                      <th className="py-2 pr-3 font-medium" title="提供 gold ids 时计算，否则为 -">
                        MRR
                      </th>
                      <th className="py-2 pr-3 font-medium" title="提供 gold ids 时计算，否则为 -">
                        NDCG
                      </th>
                      <th className="py-2 pr-3 font-medium">检索耗时</th>
                      <th className="py-2 pr-3 font-medium">生成耗时</th>
                      <th className="py-2 pr-3 font-medium">总耗时</th>
                      <th className="py-2 pr-1 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {logList.map((log: RetrievalLog) => {
                      const expanded = expandedId === log.id;
                      return (
                        <Fragment key={log.id}>
                          <tr
                            className="cursor-pointer border-b transition-colors hover:bg-zinc-50"
                            onClick={() =>
                              setExpandedId(expanded ? null : log.id)
                            }
                          >
                            <td className="py-2 pr-3 text-xs text-zinc-400">
                              {new Date(log.createdAt).toLocaleString()}
                            </td>
                            <td className="max-w-xs truncate py-2 pr-3 font-medium">
                              {log.query}
                            </td>
                            <td className="py-2 pr-3">
                              <div className="flex items-center gap-1">
                                <Badge className="bg-zinc-100 text-zinc-600">
                                  K={log.topK}
                                </Badge>
                                {log.intelligence && (
                                  <Badge className="bg-blue-100 text-blue-700">
                                    智能链路
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="py-2 pr-3 text-zinc-600">
                              {log.citationCount}
                              <span className="text-xs text-zinc-400">
                                {" "}
                                / {log.evidenceCount}
                              </span>
                            </td>
                            <td className="py-2 pr-3">
                              <Badge className={scoreColor(log.topScore)}>
                                {log.topScore != null
                                  ? log.topScore.toFixed(3)
                                  : "-"}
                              </Badge>
                            </td>
                            <td className="py-2 pr-3">
                              <Badge className={scoreColor(log.recallAtK)}>
                                {log.recallAtK != null
                                  ? log.recallAtK.toFixed(3)
                                  : "-"}
                              </Badge>
                            </td>
                            <td className="py-2 pr-3">
                              <Badge className={scoreColor(log.hitRate)}>
                                {log.hitRate != null ? log.hitRate.toFixed(3) : "-"}
                              </Badge>
                            </td>
                            <td className="py-2 pr-3">
                              <Badge className={scoreColor(log.mrr)}>
                                {log.mrr != null ? log.mrr.toFixed(3) : "-"}
                              </Badge>
                            </td>
                            <td className="py-2 pr-3">
                              <Badge className={scoreColor(log.ndcg)}>
                                {log.ndcg != null ? log.ndcg.toFixed(3) : "-"}
                              </Badge>
                            </td>
                            <td className="py-2 pr-3">
                              <Badge className={latencyColor(log.retrievalMs)}>
                                {formatMs(log.retrievalMs)}
                              </Badge>
                            </td>
                            <td className="py-2 pr-3">
                              <Badge className={latencyColor(log.generationMs)}>
                                {formatMs(log.generationMs)}
                              </Badge>
                            </td>
                            <td className="py-2 pr-3">
                              <Badge className={latencyColor(log.latencyMs)}>
                                {formatMs(log.latencyMs)}
                              </Badge>
                            </td>
                            <td className="py-2 pr-1 text-zinc-400">
                              {expanded ? (
                                <ChevronUp className="h-4 w-4" />
                              ) : (
                                <ChevronDown className="h-4 w-4" />
                              )}
                            </td>
                          </tr>
                          {expanded && (
                            <tr key={`${log.id}-detail`}>
                              <td colSpan={13} className="bg-zinc-50 px-4 py-3">
                                <div className="space-y-3">
                                  {/* 查询详情 */}
                                  {log.effectiveQueries.length > 0 && (
                                    <div>
                                      <span className="text-xs font-medium text-zinc-500">
                                        实际检索 query：
                                      </span>
                                      {log.effectiveQueries.map((q, i) => (
                                        <span
                                          key={i}
                                          className="ml-2 rounded bg-zinc-200 px-1.5 py-0.5 text-xs text-zinc-700"
                                        >
                                          {q}
                                        </span>
                                      ))}
                                    </div>
                                  )}

                                  {/* 回答 */}
                                  {log.answer && (
                                    <div>
                                      <span className="text-xs font-medium text-zinc-500">
                                        回答：
                                      </span>
                                      <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700">
                                        {log.answer}
                                      </p>
                                    </div>
                                  )}

                                  {/* chunk IDs */}
                                  {log.chunkIds.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                      <span className="text-xs font-medium text-zinc-500">
                                        召回 chunks：
                                      </span>
                                      {log.chunkIds.map((id, i) => (
                                        <span
                                          key={i}
                                          className="rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-xs text-zinc-600"
                                        >
                                          {id.slice(0, 8)}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
