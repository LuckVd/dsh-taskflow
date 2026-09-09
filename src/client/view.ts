/**
 * 纯视图模型：看板分组、卡片摘要、过滤、时间线合并（无 DOM，可单测）。
 *
 * @module dsh-taskflow/client
 */

import type { Ledger, Subtask, Task, TaskEvent, SubtaskEvent } from '../protocol/types.ts'
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
  /** 需要人工动作的提示（验收/权限确认/重试）。 */
  awaitingHuman?: 'review' | 'permission' | 'blocked' | 'decompose'
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
  const doneCount = task.subtasks.filter(s => s.status === 'done').length
  const totalCount = task.subtasks.length
  const blockedEvent = [...task.events].reverse().find(e => e.to === 'blocked')
  let awaitingHuman: CardSummary['awaitingHuman']
  if (task.status === 'review') awaitingHuman = 'review'
  else if (task.events.some(e => e.kind === 'awaiting-permission-confirm')) awaitingHuman = 'permission'
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
  review: '待验收',
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

export type { Ledger }
