/**
 * 纯视图模型：看板分组、卡片摘要、过滤、时间线合并（无 DOM，可单测）。
 *
 * @module dsh-taskflow/client
 */

import type { ApprovalRecord, Ledger, Subtask, Task, TaskEvent, SubtaskEvent } from '../protocol/types.ts'
import { BOARD_COLUMNS } from '../protocol/types.ts'

export interface TaskFilter {
  query?: string
  status?: 'all' | 'active' | 'blocked' | 'review' | 'done' | 'archived'
}

export interface CardSummary {
  task: Task
  columnId: (typeof BOARD_COLUMNS)[number]['id']
  /** 子任务进度 done/total。 */
  doneCount: number
  totalCount: number
  /** 最近一次活动时间（任务与子任务事件的最新值）。 */
  lastActivity: number
  /** 受阻原因（blocked 时的最近原因事件）。 */
  blockedReason?: string
  /** 需要人工动作的提示（审批最急 > 验收 > 权限确认 > 重试 > 拆解）。 */
  awaitingHuman?: 'approval' | 'review' | 'permission' | 'blocked' | 'decompose'
}

/** blocked 回原列（§4.9）：有子任务 → 实现中列标红；拆解期受阻 → 待办列。 */
export function columnOf(status: Task['status'], hasSubtasks = false): CardSummary['columnId'] {
  if (status === 'blocked') return hasSubtasks ? 'inProgress' : 'todo'
  for (const column of BOARD_COLUMNS) {
    if (column.statuses.includes(status)) return column.id
  }
  return 'done'
}

export function taskLastActivity(task: Task): number {
  let latest = task.updatedAt
  for (const sub of task.subtasks) {
    const last = sub.history.at(-1)?.at
    if (last !== undefined && last > latest) latest = last
  }
  return latest
}

export function cardSummary(task: Task): CardSummary {
  // 执行完成数：done 或 review 都算（§4.6 语义：子任务不再逐个人验，review = 执行举证完毕、
  // 随任务终审一并定案）——否则终检就绪的任务卡片会显示「0/12 子任务」，像什么都没做。
  const doneCount = task.subtasks.filter(s => s.status === 'done' || s.status === 'review').length
  const totalCount = task.subtasks.length
  const blockedEvent = [...task.events].reverse().find(e => e.to === 'blocked')
  const approvalPending = (task.approvals ?? []).some(a => a.status === 'pending')
  let awaitingHuman: CardSummary['awaitingHuman']
  if (approvalPending) awaitingHuman = 'approval'
  else if (task.status === 'review') awaitingHuman = 'review'
  // 权限确认要看「当前状态」，不是事件历史：awaiting-permission-confirm 是留痕（历史事实），
  // 确认过/已终态的任务即使事件里留过痕也不再等待（真机 2026-09-12：done 任务卡片仍显示
  // 「执行需确认」——合法性 = in-progress 且权限位未置真）。
  else if (task.status === 'in-progress' && !task.permissionConfirmed) awaitingHuman = 'permission'
  else if (task.status === 'blocked') awaitingHuman = 'blocked'
  else if (task.status === 'draft') awaitingHuman = 'decompose'
  return {
    task,
    columnId: columnOf(task.status, task.subtasks.length > 0),
    doneCount,
    totalCount,
    lastActivity: taskLastActivity(task),
    ...(blockedEvent?.reason !== undefined ? { blockedReason: blockedEvent.reason } : {}),
    ...(awaitingHuman !== undefined ? { awaitingHuman } : {}),
  }
}

// —— 权限审批（§7.1b）——

/** 待裁决审批的视图投影（通知栏与抽屉审批区共用）。 */
export interface PendingApprovalView {
  id: string
  taskId: string
  subtaskId: string
  subtaskTitle: string
  sessionId: string
  toolName: string
  reason?: string
  createdAt: number
}

export function pendingApprovalsOf(task: Task): PendingApprovalView[] {
  const titleOf = new Map(task.subtasks.map(s => [s.id, s.title]))
  return (task.approvals ?? [])
    .filter(record => record.status === 'pending')
    .map(record => ({
      id: record.id,
      taskId: task.id,
      subtaskId: record.subtaskId,
      subtaskTitle: titleOf.get(record.subtaskId) ?? record.subtaskId,
      sessionId: record.sessionId,
      toolName: record.toolName,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      createdAt: record.createdAt,
    }))
}

/** 全部任务的待裁决审批数（工具栏角标）。 */
export function pendingApprovalCount(tasks: readonly Task[]): number {
  return tasks.reduce((sum, task) => sum + (task.approvals?.filter(a => a.status === 'pending').length ?? 0), 0)
}

/** 看板列分组（archived 不出现在主视图，US-13）。 */
export function boardGroups(tasks: readonly Task[]): Array<{ id: CardSummary['columnId']; title: string; cards: CardSummary[] }> {
  const visible = tasks.filter(t => t.status !== 'archived')
  return BOARD_COLUMNS.map(column => ({
    id: column.id,
    title: column.title,
    cards: visible
      .filter(task => columnOf(task.status, task.subtasks.length > 0) === column.id)
      .map(cardSummary)
      .sort((a, b) => b.lastActivity - a.lastActivity),
  }))
}

export function filterTasks(tasks: readonly Task[], filter: TaskFilter): Task[] {
  let list = [...tasks]
  if (filter.status === 'active') list = list.filter(t => !['done', 'cancelled', 'archived'].includes(t.status))
  else if (filter.status && filter.status !== 'all') list = list.filter(t => t.status === filter.status)
  const query = filter.query?.trim().toLowerCase()
  if (query !== undefined && query.length > 0) {
    list = list.filter(
      task =>
        task.title.toLowerCase().includes(query)
        || task.description.toLowerCase().includes(query)
        || task.subtasks.some(
          s => s.title.toLowerCase().includes(query) || s.detail.toLowerCase().includes(query),
        ),
    )
  }
  return list
}

/** 右上角「待验收」角标数（US-15 的 M1 形态）。 */
export function reviewBadgeCount(tasks: readonly Task[]): number {
  return tasks.filter(t => t.status === 'review').length
}

// —— 时间线 ——

export interface TimelineEntry {
  id: string
  at: number
  actor: 'human' | 'ai' | 'system'
  /** 展示标签：状态流转 / 证据提交 / 进度 / 恢复 …。 */
  label: string
  detail?: string
  subtaskId?: string
  sessionId?: string
  /** 会话模型标签（refs.model 留痕；缺省 = 宿主默认）。 */
  model?: string
  /** 是否状态变化（用于视觉区分）。 */
  isTransition: boolean
}

const ACTOR_LABEL: Record<TimelineEntry['actor'], string> = { human: '人', ai: 'AI', system: '系统' }

const KIND_LABEL: Record<string, string> = {
  'evidence-submitted': '证据提交',
  'blocker-reported': '报障',
  progress: '进度',
  recovery: '恢复',
  'session-started': '会话启动',
  'session-ended-no-evidence': '会话结束未举证',
  'session-crashed': '会话崩溃',
  'subtasks-edited': '编辑拆解',
  'contract-edited': '编辑合同',
  'decompose-retry': '拆解重试',
  'permission-confirmed': '权限确认',
  'awaiting-permission-confirm': '等待权限确认',
  'max-rounds-raised': '调整迭代上限',
  'reject-blocked': '打回受阻',
  'approval-requested': '发起权限审批',
  'approval-elevated': '审批 · 完全放行',
  'approval-rejected': '审批 · 拒绝',
  'approval-expired': '审批失效',
  'session-stalled': '看门狗超时',
  'dep-rollback': '依赖回退',
}

const TASK_STATUS_LABEL: Record<Task['status'], string> = {
  draft: '草稿',
  decomposing: '拆解中',
  ready: '就绪',
  'in-progress': '实现中',
  review: '待验收',
  done: '已完成',
  blocked: '受阻',
  cancelled: '已取消',
  archived: '已归档',
}

const SUBTASK_STATUS_LABEL: Record<Subtask['status'], string> = {
  pending: '排队',
  'in-progress': '实现中',
  // §4.6：子任务是过程举证，不是人的验收对象——review 态读作「举证完毕」，
  // 避免「待验收」误导人去逐个子任务验收。
  review: '举证完毕',
  done: '已批准',
  rejected: '被打回',
  blocked: '受阻',
}

function describeTaskEvent(event: TaskEvent): TimelineEntry {
  const isTransition = event.from !== event.to
  const label = isTransition
    ? `${event.from === null ? '创建' : TASK_STATUS_LABEL[event.from]} → ${TASK_STATUS_LABEL[event.to]}`
    : KIND_LABEL[event.kind ?? ''] ?? event.kind ?? '记录'
  return {
    id: event.id,
    at: event.at,
    actor: event.actor,
    label,
    ...(event.reason !== undefined ? { detail: event.reason } : {}),
    ...(event.refs?.subtaskId !== undefined ? { subtaskId: event.refs.subtaskId } : {}),
    ...(event.refs?.sessionId !== undefined ? { sessionId: event.refs.sessionId } : {}),
    ...(event.refs?.model !== undefined ? { model: event.refs.model } : {}),
    isTransition,
  }
}

function describeSubtaskEvent(event: SubtaskEvent, subtask: Subtask): TimelineEntry {
  const isTransition = event.from !== event.to
  const label = isTransition
    ? `${event.from === null ? '创建' : SUBTASK_STATUS_LABEL[event.from]} → ${SUBTASK_STATUS_LABEL[event.to]}`
    : KIND_LABEL[event.kind ?? ''] ?? event.kind ?? '记录'
  return {
    id: event.id,
    at: event.at,
    actor: event.actor,
    label: `「${subtask.title}」${label}`,
    ...(event.reason !== undefined ? { detail: event.reason } : {}),
    subtaskId: subtask.id,
    ...(event.refs?.sessionId !== undefined ? { sessionId: event.refs.sessionId } : {}),
    ...(event.refs?.model !== undefined ? { model: event.refs.model } : {}),
    isTransition,
  }
}

/** 任务级 + 子任务级事件合并按时间倒序（US-09 / §4.8 M1 形态）。 */
export function mergedTimeline(task: Task): TimelineEntry[] {
  const entries: TimelineEntry[] = task.events.map(describeTaskEvent)
  for (const sub of task.subtasks) {
    entries.push(...sub.history.map(event => describeSubtaskEvent(event, sub)))
  }
  return entries.sort((a, b) => b.at - a.at)
}

export function actorLabel(actor: TimelineEntry['actor']): string {
  return ACTOR_LABEL[actor] ?? actor
}

export function statusLabel(status: Task['status']): string {
  return TASK_STATUS_LABEL[status] ?? status
}

export function subtaskStatusLabel(status: Subtask['status']): string {
  return SUBTASK_STATUS_LABEL[status] ?? status
}

// —— 队列可视化（FR-13：排队/等依赖一眼可辨）——

export interface SubtaskWait {
  kind: 'deps' | 'wip'
  /** kind=deps 时：尚未 done 的直接依赖标题（展示「等谁」）。 */
  blockers: string[]
}

/**
 * 子任务排队原因：任务执行中、子任务在排队态（pending / 无会话的 in-progress）时——
 * 直接依赖产物未就绪（done/review 之外）→ 等依赖（DAG 守卫，FR-12）；
 * 否则 → 等并发空位（WIP，FR-13）。非排队态返回 undefined。
 */
export function subtaskWait(task: Task, sub: Subtask): SubtaskWait | undefined {
  if (task.status !== 'in-progress') return undefined
  const queued = sub.status === 'pending' || (sub.status === 'in-progress' && sub.sessionId === undefined)
  if (!queued) return undefined
  const byId = new Map(task.subtasks.map(s => [s.id, s]))
  const blockers: string[] = []
  for (const dep of sub.deps) {
    const target = byId.get(dep)
    // 未知 dep 与宿主侧 fail-closed 语义一致：视作未满足
    if (target === undefined || (target.status !== 'done' && target.status !== 'review')) blockers.push(target?.title ?? dep)
  }
  if (blockers.length > 0) return { kind: 'deps', blockers }
  return { kind: 'wip', blockers: [] }
}

/** 距现在的相对时间。 */
export function relativeTime(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  const minute = 60_000
  if (delta < minute) return '刚刚'
  if (delta < 60 * minute) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))} 小时前`
  return `${Math.floor(delta / (24 * 60 * minute))} 天前`
}

/** 完成度 0–1（无子任务时按状态估）。 */
export function progressRatio(summary: CardSummary): number {
  if (summary.totalCount === 0) {
    if (summary.task.status === 'done') return 1
    if (summary.task.status === 'review') return 0.9
    return summary.task.status === 'draft' ? 0 : 0.4
  }
  return summary.doneCount / summary.totalCount
}

/** 证据产出会话的模型标签（子任务留痕反查；无记录 = 宿主默认）。 */
export function modelForSession(sub: Subtask, sessionId: string): string | undefined {
  const event = [...sub.history].reverse().find(event => event.refs?.sessionId === sessionId && event.refs?.model !== undefined)
  return event?.refs?.model
}

/** 字节数的人类可读形态（交付物预览的 size 展示用）。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '?'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** 交付物路径的短形态：保留文件名与父目录名，中间省略（窄面板可读）。 */
export function shortArtifactPath(path: string, max = 46): string {
  if (path.length <= max) return path
  const segments = path.split('/').filter(s => s.length > 0)
  const fileName = segments[segments.length - 1] ?? path
  const parent = segments[segments.length - 2]
  const head = parent === undefined ? fileName : `${parent}/${fileName}`
  if (head.length <= max) return `…/${head}`
  return `…/${fileName.slice(-(max - 2))}`
}

// —— 周期统计（FR-20：吞吐 / 一次通过率 / 平均迭代轮次 / 拆解采纳率） ——

export interface ReportStats {
  /** 进行中口径（非终态、非归档）。 */
  activeCount: number
  /** 累计完成（done，不含归档可见性差异——archived 也是曾经 done）。 */
  doneTotal: number
  /** 近 7/30 天完成数（按任务级 done 事件时间）。 */
  doneLast7d: number
  doneLast30d: number
  /** 一次验收通过率：done 且 round===1（从未被打回）/ done 总数；无样本为 null。 */
  firstPassRate: number | null
  /** 平均迭代轮次：done 任务 round 均值；无样本为 null。 */
  avgRounds: number | null
  /** 拆解采纳率：拆解后未发生过 editSubtasks 的任务占比；无拆解样本为 null。 */
  decomposeAdoptionRate: number | null
  /** 被打回过的任务数（历史累计，round>1 的非 draft 任务）。 */
  reworkedCount: number
}

/** 任务完成时间：任务级事件里最后一次转移到 done 的时刻。 */
function doneAt(task: Task): number | undefined {
  const event = [...task.events].reverse().find(e => e.to === 'done')
  return event?.at
}

export function reportStats(tasks: readonly Task[], now = Date.now()): ReportStats {
  const day = 24 * 60 * 60_000
  const visible = tasks.filter(t => t.status !== 'archived')
  const doneTasks = tasks.filter(t => t.status === 'done' || (t.status === 'archived' && doneAt(t) !== undefined))
  const doneTimes = doneTasks.map(doneAt).filter((t): t is number => t !== undefined)
  const roundSum = doneTasks.reduce((sum, t) => sum + t.round, 0)
  const firstPass = doneTasks.filter(t => t.round === 1).length
  const decomposed = tasks.filter(t => t.subtasks.length > 0)
  const unedited = decomposed.filter(
    t => !t.events.some(e => e.kind === 'subtasks-edited'),
  ).length
  return {
    activeCount: visible.filter(t => !['done', 'cancelled'].includes(t.status)).length,
    doneTotal: doneTasks.length,
    doneLast7d: doneTimes.filter(at => now - at <= 7 * day).length,
    doneLast30d: doneTimes.filter(at => now - at <= 30 * day).length,
    firstPassRate: doneTasks.length === 0 ? null : firstPass / doneTasks.length,
    avgRounds: doneTasks.length === 0 ? null : roundSum / doneTasks.length,
    decomposeAdoptionRate: decomposed.length === 0 ? null : unedited / decomposed.length,
    reworkedCount: tasks.filter(t => t.round > 1 && t.subtasks.length > 0).length,
  }
}

/** 比率的人类可读形态（0.833 → 83%）。 */
export function percentOf(rate: number | null): string {
  if (rate === null) return '—'
  return `${Math.round(rate * 100)}%`
}

/** 均值的人类可读形态（1.67 → 1.7；null → —）。 */
export function decimalOf(value: number | null): string {
  if (value === null) return '—'
  return value.toFixed(1)
}

export type { Ledger }
