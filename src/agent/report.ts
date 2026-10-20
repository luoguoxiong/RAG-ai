import type { EvalMetrics } from "../db/schema/eval.js";
import { METRIC_LABELS } from "../evaluation/regression.js";
import { EVAL_METRIC_KEYS } from "../evaluation/metrics.js";
import type {
  IssueStage,
  IssueStats,
  RagTuningConfig,
  WeakQuery,
} from "../db/schema/agent.js";
import { estimateCostProxy } from "./config-space.js";

/**
 * Agent Markdown 报告渲染器：
 * - renderDiagnosisReport：Badcase 错误分析报告（功能 1）
 * - renderTuningReport：参数调优方案 + 优化前后对比报告（功能 2）
 * - renderAssessmentReport：评估集整体质量测评报告（功能 3）
 */

export const STAGE_LABELS: Record<IssueStage, string> = {
  NO_EVIDENCE: "检索零召回",
  RETRIEVAL_RECALL: "检索召回不足",
  RANKING: "排序质量差",
  WEAK_EVIDENCE: "证据得分过弱",
  NO_CITATION: "有证据但回答无引用",
  GENERATION_GROUNDING: "答案偏离证据（疑似幻觉）",
  GENERATION_RELEVANCE: "答案与问题不相关",
  SLOW_RETRIEVAL: "检索阶段耗时超标",
  SLOW_GENERATION: "生成阶段耗时超标",
  NO_CLEAR_ISSUE: "未发现明确问题",
};

/** 各阶段的归因解释与建议（报告正文 + 调优方向映射） */
export const STAGE_PLAYBOOK: Record<IssueStage, { cause: string; action: string }> = {
  NO_EVIDENCE: {
    cause: "混合检索未命中任何证据，可能为查询表述与语料措辞差异过大，或数据未索引。",
    action: "开启 Query Intelligence（Rewrite/MultiQuery）扩大召回；确认相关文档已摄入并索引完成。",
  },
  RETRIEVAL_RECALL: {
    cause: "相关证据未进入 Top-K 召回窗口，召回能力不足。",
    action: "增大 Top-K、开启/增加 Multi Query 变体；若持续偏低需检查切片边界与 Embedding 质量。",
  },
  RANKING: {
    cause: "相关证据已召回但排名靠后，RRF 融合排序未能将其前置。",
    action: "确保 Reranker 开启；必要时增大候选窗口后依靠重排前置相关证据。",
  },
  WEAK_EVIDENCE: {
    cause: "无 ground truth 场景下 Top 证据得分偏低，证据与问题匹配度弱。",
    action: "开启 Query Intelligence 改写查询；检查语料是否覆盖该主题。",
  },
  NO_CITATION: {
    cause: "存在召回证据但回答未携带引用，上下文组装或生成约束可能存在问题。",
    action: "检查上下文预算是否把证据截断丢失；核对生成 Prompt 的引用输出约束。",
  },
  GENERATION_GROUNDING: {
    cause: "LLM 复核判定回答包含证据不支持的内容（幻觉倾向）。",
    action: "缩小 Top-K 降低噪声；在 Prompt 中强化「仅依据证据回答、不足则明说」的约束。",
  },
  GENERATION_RELEVANCE: {
    cause: "回答与问题意图不匹配或回答为空。",
    action: "检查 Query 改写是否偏离原意；核对生成 Prompt 与模型输出长度限制。",
  },
  SLOW_RETRIEVAL: {
    cause: "检索阶段耗时超标（向量/关键词路或重排）。",
    action: "关闭重排或精简 Query Intelligence 链路；检查外部依赖超时与缓存命中。",
  },
  SLOW_GENERATION: {
    cause: "生成阶段耗时超标（上下文过长或模型响应慢）。",
    action: "缩小 Top-K 与上下文预算；更换更快的生成模型或降低输出长度。",
  },
  NO_CLEAR_ISSUE: { cause: "未发现明确问题。", action: "无需处理。" },
};

const SEVERITY_LABELS: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
  none: "-",
};

function fmtMetric(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(4) : "-";
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** 综合评分 → 质量等级（A 优秀 / B 良好 / C 待改进 / D 较差） */
export function gradeOf(score: number): { grade: string; label: string } {
  if (score >= 0.85) return { grade: "A", label: "优秀" };
  if (score >= 0.7) return { grade: "B", label: "良好" };
  if (score >= 0.55) return { grade: "C", label: "待改进" };
  return { grade: "D", label: "较差" };
}

export interface DiagnosisReportInput {
  diagnosisId: string;
  sinceDays: number;
  sampleCount: number;
  badcaseCount: number;
  healthScore: number;
  issueStats: IssueStats;
  /** 展示的样本（按严重程度排序后的 badcase） */
  cases: {
    query: string;
    stage: IssueStage;
    severity: string;
    rootCause: string;
    suggestion: string;
  }[];
  /** 是否使用了 LLM 复核 */
  llmReviewed: boolean;
}

/** 功能 1：Badcase 错误分析报告 */
export function renderDiagnosisReport(input: DiagnosisReportInput): string {
  const lines: string[] = [];
  lines.push(`# RAG Badcase 错误分析报告`);
  lines.push("");
  lines.push(
    `- 任务：\`${input.diagnosisId}\`  `,
    `- 数据窗口：最近 ${input.sinceDays} 天线上检索日志  `,
    `- 样本数：${input.sampleCount}（badcase ${input.badcaseCount} 条）  `,
    `- 健康度：${pct(input.healthScore)}  `,
    `- LLM 复核：${input.llmReviewed ? "已启用" : "未启用（仅规则诊断）"}`,
  );
  lines.push("");

  lines.push("## 一、问题分布（错在哪一步）");
  lines.push("");
  lines.push("| 阶段 | 数量 | 占比 | 说明 |");
  lines.push("| --- | ---: | ---: | --- |");
  const sorted = (Object.entries(input.issueStats) as [IssueStage, number][]).sort(
    (a, b) => b[1] - a[1],
  );
  for (const [stage, count] of sorted) {
    lines.push(
      `| ${STAGE_LABELS[stage]}（\`${stage}\`） | ${count} | ${pct(
        input.sampleCount > 0 ? count / input.sampleCount : 0,
      )} | ${STAGE_PLAYBOOK[stage].cause} |`,
    );
  }
  if (sorted.length === 0) {
    lines.push("| - | 0 | - | 窗口内样本未发现明确问题 |");
  }
  lines.push("");

  lines.push("## 二、修复建议（按问题占比排序）");
  lines.push("");
  let i = 1;
  for (const [stage, count] of sorted) {
    if (stage === "NO_CLEAR_ISSUE") continue;
    lines.push(
      `${i++}. **${STAGE_LABELS[stage]}**（${count} 条）：${STAGE_PLAYBOOK[stage].action}`,
    );
  }
  if (i === 1) lines.push("暂无需处理的明确问题。");
  lines.push("");

  lines.push("## 三、典型 Badcase 明细");
  lines.push("");
  lines.push("| 查询 | 问题阶段 | 严重度 | 根因 | 建议 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const c of input.cases.slice(0, 20)) {
    lines.push(
      `| ${c.query.replaceAll("|", "\\|").slice(0, 60)} | ${STAGE_LABELS[c.stage]} | ${
        SEVERITY_LABELS[c.severity] ?? c.severity
      } | ${c.rootCause.replaceAll("|", "\\|").slice(0, 80)} | ${c.suggestion
        .replaceAll("|", "\\|")
        .slice(0, 80)} |`,
    );
  }
  if (input.cases.length === 0) {
    lines.push("| - | - | - | 窗口内无 badcase | - |");
  }
  lines.push("");

  lines.push("## 四、下一步");
  lines.push("");
  lines.push(
    "- 将本报告的问题分布作为输入，运行参数自动调优：`POST /agent/tuning`（或 `pnpm agent:tune --dataset <评测集id>`）。",
  );
  lines.push(
    "- 对标注定量结论：为高频 badcase 查询补充 ground truth（goldChunkIds），提升召回/排序指标的可信度。",
  );
  lines.push("");
  return lines.join("\n");
}

export interface TuningReportInput {
  tuningRunId: string;
  datasetName: string;
  hypothesis: string;
  primaryMetric: string;
  baselineConfig: RagTuningConfig;
  baselineMetrics: Partial<EvalMetrics>;
  baselineUtility: number;
  best: {
    config: RagTuningConfig;
    metrics: Partial<EvalMetrics>;
    utility: number;
    evalRunId: string | null;
  } | null;
  deltas: Partial<Record<keyof EvalMetrics, number>>;
  experiments: {
    name: string;
    changes: Record<string, unknown>;
    status: string;
    gatePassed: boolean | null;
    utility: number | null;
    reason: string;
  }[];
  totalExperiments: number;
  gatePassedCount: number;
}

function renderConfig(cfg: RagTuningConfig): string {
  return `topK=${cfg.topK}，reranker=${cfg.useReranker ? "开" : "关"}，intelligence=${
    cfg.intelligence ? "开" : "关"
  }，multiQueryCount=${cfg.multiQueryCount}`;
}

/** 功能 2：调优方案与优化前后对比报告 */
export function renderTuningReport(input: TuningReportInput): string {
  const lines: string[] = [];
  lines.push(`# RAG 参数自动调优报告`);
  lines.push("");
  lines.push(
    `- 任务：\`${input.tuningRunId}\`  `,
    `- 评测集：${input.datasetName}  `,
    `- 主优化指标：\`${input.primaryMetric}\`  `,
    `- 实验数：${input.totalExperiments}（通过硬约束门禁 ${input.gatePassedCount} 个）`,
  );
  lines.push("");
  lines.push(`## 一、优化假设`);
  lines.push(input.hypothesis || "（无）");
  lines.push("");

  lines.push("## 二、优化方案（实验计划与结果）");
  lines.push("");
  lines.push("| 实验 | 参数变更 | 状态 | 门禁 | 效用分 | 原因 |");
  lines.push("| --- | --- | --- | --- | ---: | --- |");
  for (const e of input.experiments) {
    const gate =
      e.gatePassed === null ? "-" : e.gatePassed ? "通过" : "未通过";
    lines.push(
      `| \`${e.name}\` | ${JSON.stringify(e.changes)} | ${e.status} | ${gate} | ${fmtMetric(
        e.utility ?? undefined,
      )} | ${e.reason.replaceAll("|", "\\|").slice(0, 60)} |`,
    );
  }
  if (input.experiments.length === 0) {
    lines.push("| - | - | - | - | - | 无候选实验 |");
  }
  lines.push("");

  lines.push("## 三、优化前后数据对比");
  lines.push("");
  lines.push(`- 基线配置：${renderConfig(input.baselineConfig)}（效用分 ${fmtMetric(input.baselineUtility)}）`);
  if (input.best) {
    lines.push(`- 推荐配置：${renderConfig(input.best.config)}（效用分 ${fmtMetric(input.best.utility)}）`);
    if (input.best.evalRunId) {
      lines.push(`- 推荐配置评测运行：\`${input.best.evalRunId}\`（逐查询明细见 \`GET /eval/runs/${input.best.evalRunId}\`）`);
    }
  } else {
    lines.push("- 未找到满足硬约束的更优配置，建议维持基线并补充评测集后重试。");
  }
  lines.push("");
  lines.push("| 指标 | 基线 | 优化后 | 变化 |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const key of EVAL_METRIC_KEYS) {
    const base = input.baselineMetrics[key];
    const best = input.best?.metrics[key];
    const delta = input.deltas[key];
    const mark =
      delta === undefined || delta === 0 ? "" : delta > 0 ? " ⬆" : " ⬇";
    lines.push(
      `| ${METRIC_LABELS[key]} | ${fmtMetric(base)} | ${fmtMetric(best)} | ${fmtMetric(
        delta,
      )}${mark} |`,
    );
  }
  lines.push(`| 成本代理（参数复杂度） | ${estimateCostProxy(input.baselineConfig).toFixed(3)} | ${
    input.best ? estimateCostProxy(input.best.config).toFixed(3) : "-"
  } | - |`);
  lines.push("");

  lines.push("## 四、发布建议");
  lines.push("");
  if (input.best) {
    const primaryDelta = input.deltas[input.primaryMetric as keyof EvalMetrics] ?? 0;
    if (primaryDelta > 0) {
      lines.push(
        `1. 推荐配置在主指标 \`${input.primaryMetric}\` 上相对基线提升 ${fmtMetric(primaryDelta)}，且无任何指标显著回退，满足硬约束。`,
      );
    } else {
      lines.push(
        `1. 推荐配置主指标 \`${input.primaryMetric}\` 无提升（Δ=${fmtMetric(primaryDelta)}），但综合效用分更高且无指标回退；可按业务偏好决定是否采纳。`,
      );
    }
    lines.push("2. 上线路径：人工审批 → 小流量灰度 → 监控质量/延迟/成本 → 稳定后放量（当前版本不自动写生产配置）。");
    lines.push("3. 回滚预案：如灰度期指标退化，恢复基线配置即可（候选参数均为运行时参数，无需重建索引）。");
  } else {
    lines.push("1. 所有候选均未同时满足「门禁通过 + 效用更高」，维持当前基线。");
    lines.push("2. 建议：扩充评测集覆盖高频 badcase 场景；检查召回类问题是否源于语料缺失（调参无法解决数据问题）。");
  }
  lines.push("");
  return lines.join("\n");
}

export interface AssessmentReportInput {
  assessmentId: string;
  datasetName: string;
  evalRunId: string;
  topK: number;
  queryCount: number;
  overallScore: number | null;
  grade: string;
  gradeLabel: string;
  /** 维度行（label + 组成指标 + 得分），状态由本函数按达标线渲染 */
  dimensions: {
    label: string;
    metrics: (keyof EvalMetrics)[];
    score: number | null;
  }[];
  metrics: Partial<EvalMetrics>;
  /** 有达标线的指标及其阈值（其余指标展示 "-"） */
  metricThresholds: Partial<Record<keyof EvalMetrics, number>>;
  problemStats: IssueStats;
  /** 命中至少一个问题的查询数 */
  problemQueryCount: number;
  weakQueries: WeakQuery[];
  strengths: string;
  weaknesses: string;
}

/** 功能 3：评估集整体质量测评报告（综合评分 + 维度评估 + 问题清单） */
export function renderAssessmentReport(input: AssessmentReportInput): string {
  const DIM_GOOD = 0.75;
  const DIM_WARN = 0.6;
  const lines: string[] = [];

  lines.push("# RAG 评估集整体质量测评报告");
  lines.push("");
  lines.push(
    `- 任务：\`${input.assessmentId}\`  `,
    `- 评估集：${input.datasetName}（\`evalRunId: ${input.evalRunId}\`）  `,
    `- Top-K：${input.topK}  `,
    `- 查询数：${input.queryCount}（命中问题 ${input.problemQueryCount} 条）`,
  );
  lines.push("");

  // 一、综合评分
  const scoreText =
    input.overallScore === null
      ? "无数据"
      : `${input.overallScore.toFixed(4)}（${(input.overallScore * 100).toFixed(1)} 分 / 100 分制）`;
  lines.push("## 一、综合评分");
  lines.push("");
  lines.push(
    `**${scoreText}　质量等级：${input.grade}（${input.gradeLabel}）**`,
  );
  lines.push("");
  lines.push(
    "> 评分口径：检索质量 35% + 上下文质量 25% + 生成质量 40%（维度内取组成指标均值）；等级 A≥0.85 / B≥0.70 / C≥0.55 / D<0.55。权重与达标线为示例值，应按业务目标调整。",
  );
  lines.push("");

  // 二、维度评分
  lines.push("## 二、分维度质量评估");
  lines.push("");
  lines.push("| 维度 | 得分 | 状态 | 包含指标 |");
  lines.push("| --- | ---: | --- | --- |");
  for (const d of input.dimensions) {
    const status =
      d.score === null
        ? "无数据"
        : d.score >= DIM_GOOD
          ? "达标"
          : d.score >= DIM_WARN
            ? "预警"
            : "严重短板";
    lines.push(
      `| ${d.label} | ${fmtMetric(d.score ?? undefined)} | ${status} | ${d.metrics
        .map((m) => METRIC_LABELS[m])
        .join("、")} |`,
    );
  }
  lines.push("");

  // 三、逐项指标
  lines.push("## 三、逐项指标");
  lines.push("");
  lines.push("| 指标 | 得分 | 达标线 | 状态 |");
  lines.push("| --- | ---: | ---: | --- |");
  for (const key of EVAL_METRIC_KEYS) {
    const v = input.metrics[key];
    const th = input.metricThresholds[key];
    const ok =
      th !== undefined && typeof v === "number" ? (v >= th ? "达标" : "未达标") : "-";
    lines.push(
      `| ${METRIC_LABELS[key]} | ${fmtMetric(v)} | ${th !== undefined ? th : "-"} | ${ok} |`,
    );
  }
  lines.push("");

  // 四、整体质量评估
  lines.push("## 四、整体质量评估");
  lines.push("");
  lines.push(`- **优势**：${input.strengths}`);
  lines.push(`- **薄弱**：${input.weaknesses}`);
  if (input.overallScore !== null) {
    const g = gradeOf(input.overallScore);
    if (g.grade === "A" || g.grade === "B") {
      lines.push(
        `- **结论**：整体质量${g.label}（${g.grade}），可在此基础上做参数调优与持续回归监控。`,
      );
    } else {
      lines.push(
        `- **结论**：整体质量${g.label}（${g.grade}），建议优先按下方问题清单修复短板，再进入调优流程。`,
      );
    }
  }
  lines.push("");

  // 五、问题清单
  lines.push("## 五、问题清单（错在哪一步）");
  lines.push("");
  lines.push("> 一条查询可能同时命中多个问题信号，各阶段计数之和可能大于问题查询数。");
  lines.push("");
  lines.push("| 问题阶段 | 命中查询数 | 归因说明 | 建议动作 |");
  lines.push("| --- | ---: | --- | --- |");
  const sorted = (Object.entries(input.problemStats) as [IssueStage, number][]).sort(
    (a, b) => b[1] - a[1],
  );
  for (const [stage, count] of sorted) {
    lines.push(
      `| ${STAGE_LABELS[stage]}（\`${stage}\`） | ${count} | ${STAGE_PLAYBOOK[stage].cause} | ${STAGE_PLAYBOOK[stage].action} |`,
    );
  }
  if (sorted.length === 0) {
    lines.push("| - | 0 | 各查询指标均在达标线内 | - |");
  }
  lines.push("");
  lines.push("### 薄弱查询排行（按单条综合分升序）");
  lines.push("");
  lines.push("| 查询 | 主问题 | 严重度 | 最弱指标 | 值 / 达标线 | 单条综合分 |");
  lines.push("| --- | --- | --- | --- | --- | ---: |");
  for (const q of input.weakQueries.slice(0, 15)) {
    lines.push(
      `| ${q.query.replaceAll("|", "\\|").slice(0, 60)} | ${STAGE_LABELS[q.stage]} | ${
        SEVERITY_LABELS[q.severity] ?? q.severity
      } | ${q.worstMetric} | ${q.worstValue.toFixed(3)} / ${q.worstThreshold} | ${q.overall.toFixed(3)} |`,
    );
  }
  if (input.weakQueries.length === 0) {
    lines.push("| - | - | - | - | - | - |");
  }
  lines.push("");

  // 六、下一步
  lines.push("## 六、下一步建议");
  lines.push("");
  lines.push(
    "- 将问题阶段作为输入运行参数调优：`POST /agent/tuning`（或 `pnpm agent:tune --dataset <评估集id>`），以本报告的薄弱场景验证候选配置。",
  );
  lines.push(
    "- 对线上真实流量做 Badcase 归因：`POST /agent/diagnosis`（或 `pnpm agent:diagnose`），与离线测评互相印证。",
  );
  lines.push(
    "- 为薄弱查询补充 ground truth（goldChunkIds / referenceAnswer / keyFacts），提升后续测评与调优的可信度。",
  );
  lines.push("");
  return lines.join("\n");
}
