import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, UploadCloud } from "lucide-react";
import { api } from "../../api/client";
import type { DocumentRow, VersionRow } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";

const statusClass: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  inactive: "bg-zinc-100 text-zinc-600",
  pending: "bg-amber-100 text-amber-700",
  indexed: "bg-green-100 text-green-700",
  uploaded: "bg-blue-100 text-blue-700",
  failed: "bg-red-100 text-red-700",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge className={statusClass[status] ?? "bg-zinc-100 text-zinc-600"}>
      {status}
    </Badge>
  );
}

export default function DocumentsPage() {
  const qc = useQueryClient();
  const [versionName, setVersionName] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const versions = useQuery({
    queryKey: ["versions"],
    queryFn: api.listVersions,
  });

  const documents = useQuery({
    queryKey: ["documents"],
    queryFn: api.listDocuments,
    // 有文档仍在索引中时，每 2 秒轮询刷新状态
    refetchInterval: (q) =>
      q.state.data?.some((d) => d.status === "pending") ? 2000 : false,
  });

  const createVersion = useMutation({
    mutationFn: () => api.createVersion(versionName),
    onSuccess: () => {
      setVersionName("");
      qc.invalidateQueries({ queryKey: ["versions"] });
    },
  });

  const activate = useMutation({
    mutationFn: (id: string) => api.activateVersion(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["versions"] }),
  });

  const upload = useMutation({
    mutationFn: () => {
      const vid = selectedVersionId || versions.data?.find((v) => v.status === "active")?.id;
      if (!vid) throw new Error("请先创建数据集版本");
      if (!file) throw new Error("请选择文件");
      return api.uploadDocument(vid, file);
    },
    onSuccess: () => {
      setFile(null);
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDocument(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["documents"] }),
  });

  const docs = documents.data ?? [];
  const vers = versions.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="border-b bg-white px-6 py-4">
        <h1 className="text-lg font-semibold">知识库</h1>
        <p className="text-sm text-zinc-500">
          数据集版本 + 文档管理（上传后异步索引，列表会自动刷新进度）
        </p>
      </header>

      <div className="space-y-6 p-6">
        {/* 版本管理 */}
        <Card>
          <CardHeader>
            <CardTitle>数据集版本</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="版本名称，如 v1 / 生产快照"
                value={versionName}
                onChange={(e) => setVersionName(e.target.value)}
              />
              <Button
                onClick={() => createVersion.mutate()}
                disabled={!versionName.trim() || createVersion.isPending}
              >
                {createVersion.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                创建版本
              </Button>
            </div>

            <ul className="space-y-2">
              {vers.map((v: VersionRow) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{v.name}</span>
                    <span className="text-xs text-zinc-400">v{v.version}</span>
                    <StatusBadge status={v.status} />
                    <span className="text-xs text-zinc-400">
                      {v.documentCount} 份文档
                    </span>
                  </div>
                  {v.status !== "active" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => activate.mutate(v.id)}
                    >
                      激活
                    </Button>
                  )}
                </li>
              ))}
              {vers.length === 0 && (
                <li className="text-sm text-zinc-400">暂无版本，请先创建</li>
              )}
            </ul>
          </CardContent>
        </Card>

        {/* 上传 */}
        <Card>
          <CardHeader>
            <CardTitle>上传文档</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <select
                className="h-9 rounded-md border border-zinc-300 bg-white px-3 text-sm"
                value={selectedVersionId}
                onChange={(e) => setSelectedVersionId(e.target.value)}
              >
                <option value="">
                  {vers.some((v) => v.status === "active")
                    ? "使用激活版本"
                    : "选择版本"}
                </option>
                {vers.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}（v{v.version}）
                  </option>
                ))}
              </select>
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="flex h-9 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm file:mr-3 file:rounded file:border-0 file:bg-zinc-100 file:px-2 file:py-1 file:text-xs"
              />
              <Button
                onClick={() => upload.mutate()}
                disabled={upload.isPending}
              >
                {upload.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UploadCloud className="h-4 w-4" />
                )}
                上传
              </Button>
            </div>
            {upload.isError && (
              <p className="text-sm text-red-600">
                {(upload.error as Error).message}
              </p>
            )}
            {file && (
              <p className="text-xs text-zinc-500">已选择：{file.name}</p>
            )}
          </CardContent>
        </Card>

        {/* 文档列表 */}
        <Card>
          <CardHeader>
            <CardTitle>文档列表</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-zinc-500">
                  <th className="py-2 font-medium">标题</th>
                  <th className="py-2 font-medium">类型</th>
                  <th className="py-2 font-medium">状态</th>
                  <th className="py-2 font-medium">创建时间</th>
                  <th className="py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d: DocumentRow) => (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">{d.title || d.sourceUri}</td>
                    <td className="py-2 pr-4 text-zinc-500">{d.sourceType}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="py-2 pr-4 text-zinc-500">
                      {new Date(d.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => remove.mutate(d.id)}
                      >
                        <Trash2 className="h-4 w-4 text-zinc-500" />
                      </Button>
                    </td>
                  </tr>
                ))}
                {docs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-zinc-400">
                      暂无文档，上传后在此显示
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}