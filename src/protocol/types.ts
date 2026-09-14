/**
 * dsh-taskflow ledger schema v1 —— 唯一数据基准（FUNCTIONS.md §2）。
 *
 * 三条不变量（任何实现必须保证）：
 * 1. Host 权威：唯一事实源在 Host 端 ledger，浏览器只是异步视图。
 * 2. 事件只追加：状态只能通过产生新 Event 改变；Event 不可修改删除。
 * 3. 无证据不进验收：running → review 由 Host 校验 Evidence 三要素齐全。
 *
 * @module dsh-taskflow/protocol
 */

// —— 顶层文档 ——

export interface Ledger {
  schemaVersion: 1
  /** 单调递增；每次变更 +1，SSE 推送。 */
  revision: number
  tasks: Task[]
}

export interface Task {
  /** tf_<随机>，创建时生成。 */
  id: string
  /** ≤ 120 字。 */
  title: string
  /** 自由文本，用户的原始诉求。 */
  description: string
  contract: Contract
  status: TaskStatus
  subtasks: Subtask[]
  /** 追加写。 */
  events: TaskEvent[]
  /** 当前迭代轮次，从 1 开始。 */
  round: number
  /** 迭代上限，null = 不限。 */
  maxRounds: number | null
  createdAt: number
  updatedAt: number
  createdBy: 'human'
  /** 拆解后自动开工（默认 true）。 */
  autoStart: boolean
  /** 权限确认门：pins.permission 高于会话默认时须人事先确认（§7.1）。 */
  permissionConfirmed: boolean
  /** 拆解会话 transcript 引用（复盘用）。 */
  decomposeSessionIds: string[]
  /** 工具提权审批记录（按任务截断保留最近 50 条，NFR-05 风格）。 */
  approvals?: ApprovalRecord[]
  /**
   * 任务级终检证据（2026-09-11 语义升级）：全部子任务完成后由终检会话产出，
   * 对照「任务级验收标准」逐条核验整体交付——这是人工终批的判定面；
   * 子任务证据自此降级为过程举证。undefined = 未终检（存量任务/终检未完成）。
   */
  evidence?: Evidence
  /** 进行中的终检会话 id（完成/失败/兜底后清除；boot 时不跨重启）。 */
  finalizeSessionId?: string
  /** 进行中的打回定位（triage）会话 id（返工范围应用后清除）。 */
  triageSessionId?: string
}

export interface Contract {
  objective: string
  /** 允许为空 → 触发 AI 补全。 */
  acceptance: AcceptanceItem[]
  sourceOfAcceptance: 'human' | 'ai-drafted' | 'ai-refined'
  /** ai-refined 时保留用户原文，UI 可对比。 */
  originalHumanAcceptance?: AcceptanceItem[]
  pins: Pins
}

export interface Pins {
  /** 绝对路径。 */
  workspace: string
  /** Agent 预设，null = 宿主默认。 */
  presetId: string | null
  /** 权限 id，如 "read-only" | "workspace-write"。 */
  permission: string
  /**
   * 执行模式（提权策略，§7.1b）：auto = 提权自动放行（完全权限）；
   * approval = 提权转人工审批（需要审批）。缺省按 permission 推导
   * （见 {@link resolveExecutionMode}，兼容无此字段的旧任务）。
   */
  executionMode?: ExecutionMode
}

/** 执行模式：决定会话内工具提权请求（approval/request）的归宿。 */
export type ExecutionMode = 'auto' | 'approval'

/** 执行模式推导：显式声明优先；旧数据按 permission 相对默认档推导。 */
export function resolveExecutionMode(pins: Pins, defaultPermission: string): ExecutionMode {
  if (pins.executionMode !== undefined) return pins.executionMode
  return pins.permission === defaultPermission ? 'approval' : 'auto'
}

/** 一次工具提权审批请求（会话内 approval/request 的落库留痕与看板裁决对象）。 */
export interface ApprovalRecord {
  /** ap_<随机>。 */
  id: string
  subtaskId: string
  sessionId: string
  /** 发起审批的工具名，如 "write"。 */
  toolName: string
  /** 宿主给出的提权理由（如 "escalate sandbox to workspace-write: …"）。 */
  reason?: string
  status: 'pending' | 'allowed' | 'elevated' | 'rejected' | 'expired'
  createdAt: number
  decidedAt?: number
  /** 裁决批语（可选）。 */
  note?: string
}

export interface AcceptanceItem {
  /** ac_<随机>。 */
  id: string
  /** 可检验的描述。 */
  text: string
}

// —— 子任务 ——

export interface Subtask {
  /** <taskId>_s<n>。 */
  id: string
  title: string
  /** 实现说明（拆解会话产出）。 */
  detail: string
  /** 拆解时强制产出，不允许为空。 */
  acceptance: AcceptanceItem[]
  /** 依赖的其他 subtask id（M1 仅展示，M2 起强制校验）。 */
  deps: string[]
  status: SubtaskStatus
  /** 子任务自身迭代轮次。 */
  round: number
  /** 最近一轮提交的证据。 */
  evidence?: Evidence
  /** 历轮全部证据摘要（按任务截断保留，NFR-05）。 */
  evidenceHistory: EvidenceSummary[]
  /** 子任务级事件。 */
  history: SubtaskEvent[]
  /** 当前/最近一轮执行的 DSH 会话 id。 */
  sessionId?: string
  sessionIds: string[]
  /** 会话启动次数。 */
  attempt: number
  /** 当前轮执行中产生的进度便签（taskflow.update_progress）。 */
  progressNotes: string[]
}

// —— 完成证明 ——

export interface Evidence {
  submittedAt: number
  /** 变更摘要（agent 产出）。 */
  changesSummary: string
  /** 验证输出（≥ 1 条）。 */
  verification: VerificationRecord[]
  /** 逐条对照验收标准（与 acceptance 等长）。 */
  selfCheck: SelfCheckItem[]
  /**
   * 交付物清单（可选，§4.5b）：本份证据结构化指认的产物本体（文件/目录）。
   * 任务级终检证据带上它，验收台才能「先看产物再看判定」；预览路由只放行
   * 此处声明过的路径（ledger 白名单，§7.4b）。undefined = 未声明。
   */
  artifacts?: Artifact[]
  refs: {
    /** 产出会话。 */
    sessionId: string
    /** diff 统计（+n −m，涉及文件列表）。 */
    diffSummary?: string
  }
}

export interface VerificationRecord {
  /** 如 "pnpm test"。 */
  label: string
  /** 命令输出摘录（截断至 8KiB）。 */
  output: string
  passed: boolean
}

/** 单条交付物声明（§4.5b，2026-09-11）：证据里结构化指认「产物本体」。 */
export interface Artifact {
  /** 产物绝对路径（文件或目录）。 */
  path: string
  /** 产物说明（如「本机整理报告 Markdown，六章节 + 两附录」）。 */
  description?: string
  /** 存在性/完整性如何被核验（如「ls -l + 章节完整性 grep」）。 */
  howVerified?: string
}

export interface SelfCheckItem {
  acceptanceId: string
  verdict: 'pass' | 'partial' | 'fail'
  note: string
}

export interface EvidenceSummary {
  round: number
  submittedAt: number
  sessionId: string
  allPassed: boolean
  changesSummary: string
}

// —— 事件（任务级与子任务级同构）——

export interface TaskEvent {
  id: string
  at: number
  /** null = 创建事件。 */
  from: TaskStatus | null
  to: TaskStatus
  actor: 'human' | 'ai' | 'system'
  /** 打回批语 / 自动转移原因等。 */
  reason?: string
  /** 事件类型标记（evidence-submitted / progress / recovery …），用于时间线渲染。 */
  kind?: string
  refs?: EventRefs
}

export interface SubtaskEvent {
  id: string
  at: number
  from: SubtaskStatus | null
  to: SubtaskStatus
  actor: 'human' | 'ai' | 'system'
  reason?: string
  kind?: string
  refs?: EventRefs
}

export interface EventRefs {
  subtaskId?: string
  sessionId?: string
  /** 会话模型标签（如 `deepseek/deepseek-chat·high`；留痕用，未配置 = 宿主默认）。 */
  model?: string
}

// —— 模型选择（全局设置，非任务数据；§PLAN-MODEL）——

/** 会话的模型选择（同宿主 agentDefaultModel 的选择形态）。 */
export interface SessionModelSelection {
  /** 已注册的 provider 路由。 */
  provider: string
  /** provider 侧模型 id。 */
  model: string
  reasoningEffort?: string
}

/**
 * 全局模型设置：两槽正交（拆解 = 规划会话，执行 = 子任务会话）。
 * null = 跟随宿主默认模型（存量行为显式化，默认值）。
 */
export interface ModelSettings {
  decompose: SessionModelSelection | null
  execution: SessionModelSelection | null
}

/**
 * 全局设置（settings.json 全量形状）：模型两槽 + 调度并发（FR-13）。
 * `maxConcurrentSubtasks` 缺省 = 跟随引擎配置（plugin config / 默认 1）；
 * 显式设置后覆盖引擎配置，即改即生效（提高并发立即放行排队子任务）。
 */
export interface GlobalSettings extends ModelSettings {
  /** 同时运行的子任务执行会话数（WIP 上限，1–8 整数；1 = 串行）。 */
  maxConcurrentSubtasks?: number
}

// —— 任务模板（FR-19，templates.json；跨 host/client 的共享形状） ——

/** 模板可携带的钉脚子集（缺省 = 跟随创建表单默认）。 */
export interface TemplatePins {
  permission?: string
  executionMode?: ExecutionMode
  presetId?: string | null
  workspace?: string
}

export interface TaskTemplate {
  /** tpl_<随机>；客户端生成，全表内唯一（校验强制）。 */
  id: string
  /** 展示名（chip 文案）。 */
  name: string
  /** 预填标题。 */
  title: string
  /** 预填描述。 */
  description: string
  /** 预填验收标准（每行一条）。 */
  acceptance: string[]
  pins?: TemplatePins
}

// —— 模型目录（/api/taskflow/models 载荷；host 自 ctx.llm 结构性投影）——

export interface ModelCatalogEffort {
  id: string
  name: string
}

export interface ModelCatalogModel {
  id: string
  name: string
  /** 仅部分模型暴露可选推理力度。 */
  reasoning?: {
    efforts: ModelCatalogEffort[]
    defaultEffort?: string
  }
}

export interface ModelCatalogGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

export interface ModelCatalog {
  /** 宿主当前默认选择（「跟随宿主默认」项的展示数据）。 */
  default: SessionModelSelection | null
  groups: ModelCatalogGroup[]
}

// —— 交付物预览（GET /api/taskflow/artifact/preview 载荷；§4.5b/§7.4b）——

/** 交付物只读预览结果：文本头部 + 截断/二进制标记。 */
export interface ArtifactPreview {
  /** 与声明一致的产物路径。 */
  path: string
  /** 磁盘上的完整字节数。 */
  size: number
  /** 超出预览上限被截断（content 只含头部）。 */
  truncated: boolean
  /** 二进制文件（含 NUL 字节嗅探命中）：content 为空，不做文本预览。 */
  binary: boolean
  /** 文本内容（UTF-8；上限内头部，截断时注明）。 */
  content: string
}

// —— 状态枚举 ——

export type TaskStatus =
  | 'draft' // 草稿：已创建，尚未触发拆解
  | 'decomposing' // 拆解中：AI 拆解会话运行中
  | 'ready' // 就绪：拆解完成，待运行
  | 'in-progress' // 实现中（用户语汇「完成中」）
  | 'review' // 待验收：全部子任务证据齐全，等人工判定
  | 'done' // 已完成：人工批准
  | 'blocked' // 受阻：执行失败/达到迭代上限/依赖死锁等
  | 'cancelled' // 已取消
  | 'archived' // 已归档（只读）

export type SubtaskStatus =
  | 'pending' // 未开始（等依赖或等调度）
  | 'in-progress' // 会话运行中
  | 'review' // 证据已提交，待人工判定
  | 'done' // 已批准
  | 'rejected' // 被打回（瞬时状态：注入批语后立即转回 in-progress）
  | 'blocked' // 失败且达到迭代上限 / 依赖无法满足

/** UI 列分组（FR-10：四列 + 受阻原列标红）。 */
export const BOARD_COLUMNS: ReadonlyArray<{
  id: 'todo' | 'inProgress' | 'review' | 'done'
  title: string
  statuses: readonly TaskStatus[]
}> = [
  { id: 'todo', title: '待办', statuses: ['draft', 'ready'] },
  { id: 'inProgress', title: '实现中', statuses: ['decomposing', 'in-progress'] },
  { id: 'review', title: '待验收', statuses: ['review'] },
  { id: 'done', title: '已完成', statuses: ['done'] },
]

/** ledger 内任务级事件上限（NFR-05 有界）。 */
export const MAX_EVENTS_PER_TASK = 500
/** 每条验证输出截断上限（§7.4）。 */
export const MAX_VERIFICATION_OUTPUT_BYTES = 8 * 1024
/** 单份证据交付物声明条数上限（§4.5b，防塞爆验收台）。20：真机任务多子报告交付可达 12 项，10 会误伤。 */
export const MAX_EVIDENCE_ARTIFACTS = 20
/** 交付物预览读取字节上限（§7.4b）：超出截断，首屏不整读大文件。 */
export const MAX_ARTIFACT_PREVIEW_BYTES = 256 * 1024
/** 单条 action 体积上限（§6）。 */
export const MAX_ACTION_BYTES = 64 * 1024;

// —— 线类型（HTTP/SSE 契约，宿主与浏览器共用）——

/** action 分发结果（§6 POST /api/taskflow/action 响应体）。 */
export interface DispatchResult {
  ok: boolean
  revision?: number
  taskId?: string
  subtaskIds?: string[]
  code?: 'format' | 'not-found' | 'guard' | 'invalid-state' | 'storage' | 'internal'
  error?: string
}

/** GET /api/taskflow/state 响应体（全量快照 + 存储 health）。 */
export interface EngineState {
  ledger: Ledger
  health: {
    corrupt: { originalPath: string; movedTo: string; at: number } | null
    lastWriteFailed: boolean
  }
}
