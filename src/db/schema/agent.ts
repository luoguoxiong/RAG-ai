import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant";
import { evalDatasets, type EvalMetrics } from "./eval";

/**
 * RAG 自优化与问题分析 Agent（对应《RAG 自动调优 Agent 设计方案》）：
 * - agent_diagnoses / agent_diagnosis_cases：功能 1，线上 Badcase 分阶段错误分析与报告
 * - agent_tuning_runs / agent_experiments：功能 2，参数自动调优（实验计划 → 离线评测 → 门禁 → 前后对比）
 */

/** 问题阶段分类：诊断只给出「错在哪一步」，不做互斥单一归因（允许多信号并存于 signals） */
export type IssueStage =
  | "NO_EVIDENCE" // 检索零召回：证据数为 0
  | "RETRIEVAL_RECALL" // 召回不足：有 ground truth 时 Recall@K 低于阈值
  | "RANKING" // 排序问题：召回达标但 NDCG 偏低（相关证据排名靠后）
  | "WEAK_EVIDENCE" // 证据质量弱：无 ground truth 时 Top 证据得分过低
  | "NO_CITATION" // 有证据但回答没有引用（可疑生成/上下文组装问题）
  | "GENERATION_GROUNDING" // 答案偏离证据（疑似幻觉，LLM 复核判定）
  | "GENERATION_RELEVANCE" // 答案与问题不相关 / 回答为空
  | "SLOW_RETRIEVAL" // 检索阶段耗时超标
  | "SLOW_GENERATION" // 生成阶段耗时超标
  | "NO_CLEAR_ISSUE"; // 未发现明确问题

export type IssueSeverity = "high" | "medium" | "low" | "none";

/** 各阶段问题计数（聚合统计） */
export type IssueStats = Partial<Record<IssueStage, number>>;

/**
 * 可调参数快照（Agent 提案 + 服务端校验钳制，LLM 不直接写生产配置）。
 * 第一版只开放低风险参数：topK / reranker 开关 / Query Intelligence 开关 / Multi Query 变体数。
 */
export interface RagTuningConfig {
  /** 检索 Top-K（1~20） */
  topK: number;
  /** 是否启用 Reranker 重排 */
  useReranker: boolean;
  /** 是否启用 Query Intelligence（Rewrite / Multi Query / HyDE） */
  intelligence: boolean;
  /** Multi Query 变体数（1~5，1 约等于关闭） */
  multiQueryCount: number;
}

/** 实验变更记录（name + 变更 + 假设，供报告与溯源） */
export interface ExperimentChange {
  name: string;
  changes: Partial<RagTuningConfig>;
  reason: string;
  expectedEffect: string;
}

/** 诊断任务的单条样本规则/LLM 信号（可观测性快照） */
export interface DiagnosisSignals {
  topScore?: number | null;
  evidenceCount: number;
  citationCount: number;
  recallAtK?: number | null;
  ndcg?: number | null;
  retrievalMs?: number | null;
  generationMs?: number | null;
  latencyMs?: number | null;
  /** 触发的全部规则信号（主 stage 之外的次要信号也保留，避免单一互斥归因） */
  triggered: string[];
  /** 规则初判阶段（LLM 复核前） */
  ruleStage: IssueStage;
  /** 是否经过 LLM 复核 */
  llmReviewed: boolean;
  /** 生成的回答文本（截断快照，供溯源与 LLM 复核） */
  answer?: string;
}

/** 测评维度得分：检索 / 上下文 / 生成（各为其组成指标的均值，[0,1]；缺数据时为 null） */
export interface DimensionScores {
  retrieval: number | null;
  context: number | null;
  generation: number | null;
}

/** 整体测评中的薄弱查询（样本级问题） */
export interface WeakQuery {
  /** 查询文本（快照） */
  query: string;
  /** 主问题阶段（多个触发信号中按优先级取最靠前） */
  stage: IssueStage;
  severity: IssueSeverity;
  /** 相对达标线缺口最大的指标 */
  worstMetric: string;
  worstValue: number;
  worstThreshold: number;
  /** 单条查询综合得分 [0,1] */
  overall: number;
}

/** 功能 1：Badcase 错误分析任务（一次分析一批线上检索日志） */
export const agentDiagnoses = pgTable(
  "agent_diagnoses",
  {
    /** 主键：诊断任务 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 状态机：diagnosing → completed / failed */
    status: text("status").notNull().default("diagnosing"),
    /** 回看窗口（天）：分析最近 N 天的线上检索日志 */
    sinceDays: integer("since_days").notNull().default(7),
    /** 分析样本数 */
    sampleCount: integer("sample_count").notNull().default(0),
    /** 判定为 badcase 的样本数 */
    badcaseCount: integer("badcase_count").notNull().default(0),
    /** 健康度：1 - badcase 率，[0,1] */
    healthScore: real("health_score"),
    /** 各阶段问题计数 */
    issueStats: jsonb("issue_stats")
      .$type<IssueStats>()
      .notNull()
      .default({}),
    /** 分析报告（markdown） */
    report: text("report"),
    /** 失败时的错误信息 */
    error: text("error"),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 完成时间 */
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("agent_diagnoses_tenant_idx").on(t.tenantId),
  }),
);

/** 功能 1：样本级诊断结果（一条线上检索日志 → 一个错误阶段结论） */
export const agentDiagnosisCases = pgTable(
  "agent_diagnosis_cases",
  {
    /** 主键：诊断样本 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 所属诊断任务（任务删除时级联删样本） */
    diagnosisId: uuid("diagnosis_id")
      .notNull()
      .references(() => agentDiagnoses.id, { onDelete: "cascade" }),
    /** 对应线上检索日志 id（溯源） */
    logId: uuid("log_id").notNull(),
    /** 用户查询文本（快照） */
    query: text("query").notNull(),
    /** 定位到的问题阶段 */
    stage: text("stage").notNull(),
    /** 严重程度 */
    severity: text("severity").notNull().default("none"),
    /** 根因描述（人类可读） */
    rootCause: text("root_cause").notNull(),
    /** 修复建议（映射到可调参数或数据治理动作） */
    suggestion: text("suggestion").notNull(),
    /** 规则 + LLM 信号快照 */
    signals: jsonb("signals").$type<DiagnosisSignals>().notNull().default({
      evidenceCount: 0,
      citationCount: 0,
      triggered: [],
      ruleStage: "NO_CLEAR_ISSUE",
      llmReviewed: false,
    }),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    diagnosisIdx: index("agent_diagnosis_cases_diagnosis_idx").on(t.diagnosisId),
  }),
);

/** 功能 2：自动调优任务（状态机：diagnosing → planning → experimenting → comparing → completed / failed） */
export const agentTuningRuns = pgTable(
  "agent_tuning_runs",
  {
    /** 主键：调优任务 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 状态机当前阶段（每步落库，可恢复可追踪） */
    status: text("status").notNull().default("diagnosing"),
    /** 调优所用评测集（固定评测集保证可复现） */
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => evalDatasets.id, { onDelete: "cascade" }),
    /** 回看窗口（天）：线上数据统计范围 */
    sinceDays: integer("since_days").notNull().default(7),
    /** 优化假设（LLM 提案或规则生成） */
    hypothesis: text("hypothesis").notNull().default(""),
    /** 主优化指标（如 recallAtK） */
    primaryMetric: text("primary_metric").notNull().default("recallAtK"),
    /** 基线配置快照 */
    baselineConfig: jsonb("baseline_config").$type<RagTuningConfig>(),
    /** 基线评测运行 id（eval_runs） */
    baselineRunId: uuid("baseline_run_id"),
    /** 基线指标 */
    baselineMetrics: jsonb("baseline_metrics").$type<Partial<EvalMetrics>>(),
    /** 胜出候选配置 */
    bestConfig: jsonb("best_config").$type<RagTuningConfig>(),
    /** 胜出候选的评测运行 id */
    bestRunId: uuid("best_run_id"),
    /** 胜出候选指标 */
    bestMetrics: jsonb("best_metrics").$type<Partial<EvalMetrics>>(),
    /** 胜出候选效用分（J = 0.4Q + 0.3R + 0.2F - 0.1C） */
    bestUtility: real("best_utility"),
    /** 优化前后对比（含 deltas 与结论） */
    comparison: jsonb("comparison").$type<Record<string, unknown>>(),
    /** 线上问题分布（调优方向依据） */
    issueStats: jsonb("issue_stats").$type<IssueStats>().notNull().default({}),
    /** 优化报告（markdown） */
    report: text("report"),
    /** 失败时的错误信息 */
    error: text("error"),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 完成时间 */
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("agent_tuning_runs_tenant_idx").on(t.tenantId),
  }),
);

/** 功能 2：实验记录（一个候选配置 = 一次离线评测 + 门禁判定） */
export const agentExperiments = pgTable(
  "agent_experiments",
  {
    /** 主键：实验 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 所属调优任务（任务删除时级联删实验） */
    tuningRunId: uuid("tuning_run_id")
      .notNull()
      .references(() => agentTuningRuns.id, { onDelete: "cascade" }),
    /** 实验名（如 topk_10 / rerank_off） */
    name: text("name").notNull(),
    /** 候选参数（完整快照，钳制后） */
    config: jsonb("config").$type<RagTuningConfig>().notNull(),
    /** 相对基线的变更（仅差异字段，供报告展示） */
    changes: jsonb("changes").$type<Partial<RagTuningConfig>>().notNull().default({}),
    /** 变更原因 */
    reason: text("reason").notNull().default(""),
    /** 预期影响指标 */
    expectedEffect: text("expected_effect").notNull().default(""),
    /** 状态：pending → running → ready / failed / skipped */
    status: text("status").notNull().default("pending"),
    /** 对应评测运行 id（eval_runs，可跳转逐查询明细） */
    evalRunId: uuid("eval_run_id"),
    /** 候选指标 */
    metrics: jsonb("metrics").$type<Partial<EvalMetrics>>(),
    /** 硬约束门禁：相对调优基线无任何指标显著回退 */
    gatePassed: boolean("gate_passed"),
    /** 门禁判定的回退指标 */
    regressedMetrics: jsonb("regressed_metrics")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 效用分（用于门禁通过者中排序选优） */
    utility: real("utility"),
    /** 失败 / 跳过原因 */
    error: text("error"),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tuningRunIdx: index("agent_experiments_tuning_run_idx").on(t.tuningRunId),
  }),
);

/**
 * 功能 3：评估集整体质量测评（一次测评 = 一次整体评测 + 综合评分 +
 * 维度化质量评估 + 问题清单）。可复用历史 eval run，不重复消耗模型调用。
 */
export const agentAssessments = pgTable(
  "agent_assessments",
  {
    /** 主键：测评任务 id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 租户隔离 */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 测评的评估集（评估集删除时级联删测评） */
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => evalDatasets.id, { onDelete: "cascade" }),
    /** 依据的评测运行（eval_runs） */
    evalRunId: uuid("eval_run_id").notNull(),
    /** 本次测评所用检索 Top-K */
    topK: integer("top_k").notNull().default(6),
    /** 状态：running → completed / failed */
    status: text("status").notNull().default("running"),
    /** 参与测评的查询数 */
    queryCount: integer("query_count").notNull().default(0),
    /** 综合质量得分 [0,1]（维度加权，权重见 assessment.ts） */
    overallScore: real("overall_score"),
    /** 质量等级：A（优秀）/ B（良好）/ C（待改进）/ D（较差） */
    grade: text("grade"),
    /** 维度得分（检索 / 上下文 / 生成） */
    dimensionScores: jsonb("dimension_scores").$type<DimensionScores>(),
    /** 8 项指标得分 */
    metricScores: jsonb("metric_scores").$type<Partial<EvalMetrics>>(),
    /** 问题信号分布（一条查询可同时命中多个信号） */
    problemStats: jsonb("problem_stats").$type<IssueStats>().notNull().default({}),
    /** 薄弱查询清单（按单条综合分升序，最差在前） */
    weakQueries: jsonb("weak_queries").$type<WeakQuery[]>().notNull().default([]),
    /** 优势维度摘要 */
    strengths: text("strengths"),
    /** 薄弱维度摘要 */
    weaknesses: text("weaknesses"),
    /** 测评报告（markdown） */
    report: text("report"),
    /** 失败时的错误信息 */
    error: text("error"),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 完成时间 */
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("agent_assessments_tenant_idx").on(t.tenantId),
  }),
);

export type AgentDiagnosisRow = typeof agentDiagnoses.$inferSelect;
export type NewAgentDiagnosisRow = typeof agentDiagnoses.$inferInsert;
export type AgentDiagnosisCaseRow = typeof agentDiagnosisCases.$inferSelect;
export type NewAgentDiagnosisCaseRow = typeof agentDiagnosisCases.$inferInsert;
export type AgentTuningRunRow = typeof agentTuningRuns.$inferSelect;
export type NewAgentTuningRunRow = typeof agentTuningRuns.$inferInsert;
export type AgentExperimentRow = typeof agentExperiments.$inferSelect;
export type NewAgentExperimentRow = typeof agentExperiments.$inferInsert;
export type AgentAssessmentRow = typeof agentAssessments.$inferSelect;
export type NewAgentAssessmentRow = typeof agentAssessments.$inferInsert;
