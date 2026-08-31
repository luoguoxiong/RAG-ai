import { useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";
import { api } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Textarea } from "../../components/ui/textarea";
import { Input } from "../../components/ui/input";

/** 将答案中的 [n] 引用高亮显示 */
function renderAnswer(answer: string) {
  return answer.split(/(\[\d+\])/g).map((part, i) =>
    /^\[\d+\]$/.test(part) ? (
      <span
        key={i}
        className="rounded bg-blue-100 px-1 font-medium text-blue-700"
      >
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export default function ChatPage() {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(6);
  const [intelligence, setIntelligence] = useState(true);

  const search = useMutation({
    mutationFn: () => api.search({ query, topK, intelligence }),
    onSuccess: () => {
      // 检索落库后刷新历史页缓存
      qc.invalidateQueries({ queryKey: ["retrieval-logs"] });
    },
  });

  const submit = () => {
    if (!query.trim() || search.isPending) return;
    search.mutate();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const data = search.data;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-4">
        <h1 className="text-lg font-semibold">检索问答</h1>
        <div className="flex items-center gap-4 text-sm text-zinc-600">
          <label className="flex items-center gap-2">
            topK
            <Input
              type="number"
              min={1}
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              className="h-8 w-20"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={intelligence}
              onChange={(e) => setIntelligence(e.target.checked)}
            />
            查询智能
          </label>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-auto px-6 py-4">
        {search.isPending && (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            检索中…
          </div>
        )}

        {data && (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="whitespace-pre-wrap leading-relaxed">
                {renderAnswer(data.answer)}
              </div>

              <div className="border-t pt-4">
                <h3 className="mb-2 text-sm font-medium text-zinc-600">
                  引用来源（{data.citations.length}）
                </h3>
                <ul className="space-y-1">
                  {data.citations.map((c) => (
                    <li key={c.index} className="text-sm text-zinc-600">
                      <span className="font-medium text-blue-700">
                        [{c.index}]
                      </span>{" "}
                      {c.title || "（无标题）"}
                      <span className="ml-2 text-xs text-zinc-400">
                        score {c.score.toFixed(3)}
                      </span>
                    </li>
                  ))}
                  {data.citations.length === 0 && (
                    <li className="text-sm text-zinc-400">暂无引用</li>
                  )}
                </ul>
              </div>

              {data.effectiveQueries && data.effectiveQueries.length > 0 && (
                <div className="border-t pt-4 text-xs text-zinc-500">
                  实际检索 query：
                  {data.effectiveQueries.map((q, i) => (
                    <span key={i} className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5">
                      {q}
                    </span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {search.isError && (
          <p className="text-sm text-red-600">
            检索失败：{(search.error as Error).message}
          </p>
        )}

        {!search.isPending && !data && !search.isError && (
          <div className="flex h-full items-center justify-center text-sm text-zinc-400">
            输入问题开始检索（Cmd/Ctrl + Enter 发送）
          </div>
        )}
      </div>

      <footer className="border-t bg-white p-4">
        <div className="flex items-end gap-2">
          <Textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="输入你的问题…"
            className="min-h-[60px] resize-none"
          />
          <Button
            onClick={submit}
            disabled={!query.trim() || search.isPending}
            className="h-10"
          >
            {search.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </footer>
    </div>
  );
}