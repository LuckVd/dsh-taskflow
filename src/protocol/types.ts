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
