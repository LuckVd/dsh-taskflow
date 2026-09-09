/**
 * 任务/子任务双层状态机（FUNCTIONS.md §3）。
 *
 * 纯函数层：只判定「从 → 到」是否合法并产出事件；业务编排（会话启动、调度）
 * 由引擎负责。事件只追加（不变量 2）：一切状态变化必须经 {@link transitionTask} /
 * {@link transitionSubtask} 落事件。
 *
 * 对 §3.1 T5 的实现裁决（文档存在表述张力，此处明确）：
 *   T5 守卫 = 全部子任务 status ∈ {review, done}（即：全部已提交证据或已被人工批准，
 *   且没有 pending / in-progress / blocked / rejected）。子任务级 S4 批准可在任务
 *   in-progress 期间先行进行；任务进入 review 即「等人工终批」，approveTask 一次性
 *   批准剩余 review 态子任务并落 T6（§4.6「任务级与子任务级判定合并为同一组点击」）。
 *
 * @module dsh-taskflow/host
 */

import { randomId } from '../protocol/actions.ts'
import type { Subtask, SubtaskEvent, SubtaskStatus, Task, TaskEvent, TaskStatus } from '../protocol/types.ts'
import { MAX_EVENTS_PER_TASK } from '../protocol/types.ts'

export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IllegalTransitionError'
  }
}

/** §3.1 任务级合法转移表（from → 允许的 to 集合）。 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['decomposing', 'cancelled'],
  decomposing: ['ready', 'blocked', 'cancelled'],
  ready: ['in-progress', 'cancelled'],
  'in-progress': ['review', 'blocked', 'cancelled'],
  review: ['done', 'in-progress', 'blocked', 'cancelled'],
  blocked: ['decomposing', 'in-progress', 'review', 'ready', 'cancelled'],
  done: ['archived'],
  cancelled: ['archived'],
  archived: [],
}

/** §3.2 子任务级合法转移表。 */
export const SUBTASK_TRANSITIONS: Readonly<Record<SubtaskStatus, readonly SubtaskStatus[]>> = {
  pending: ['in-progress', 'blocked'],
  'in-progress': ['review', 'blocked'],
  review: ['done', 'rejected'],
  rejected: ['in-progress'],
  done: [],
  blocked: ['pending', 'done'],
}

const TASK_TERMINALS: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled', 'archived'])

export function isTaskTerminal(status: TaskStatus): boolean {
  return TASK_TERMINALS.has(status)
}

/** 校验并执行一次任务级转移（含 T1 创建：from = null）。 */
export function transitionTask(
  task: Task,
  to: TaskStatus,
  meta: { actor: TaskEvent['actor']; reason?: string; refs?: TaskEvent['refs'] },
): TaskEvent {
  const from = task.status
  const allowed = TASK_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError(`task ${task.id}: illegal transition ${from} → ${to}`)
  }
  const event: TaskEvent = {
    id: `ev_${randomId()}`,
    at: Date.now(),
    from,
    to,
    actor: meta.actor,
    ...(meta.reason === undefined ? {} : { reason: meta.reason }),
    ...(meta.refs === undefined ? {} : { refs: meta.refs }),
  }
  task.status = to
  task.updatedAt = event.at
  task.events.push(event)
  trimEvents(task.events)
  return event
}

/** 创建事件（T1：from = null）。 */
export function appendCreationEvent(task: Task, reason?: string): TaskEvent {
  const event: TaskEvent = {
    id: `ev_${randomId()}`,
    at: Date.now(),
    from: null,
    to: task.status,
    actor: 'human',
    ...(reason === undefined ? {} : { reason }),
  }
  task.events.push(event)
  return event
}

/** 子任务创建事件（S1：from = null → pending）。 */
export function appendSubtaskCreationEvent(subtask: Subtask, reason?: string): SubtaskEvent {
  const event: SubtaskEvent = {
    id: `sev_${randomId()}`,
    at: Date.now(),
    from: null,
    to: subtask.status,
    actor: 'system',
    ...(reason === undefined ? {} : { reason }),
  }
  subtask.history.push(event)
  return event
}

/** 校验并执行一次子任务级转移（S2 起的状态流转）。 */
export function transitionSubtask(
  subtask: Subtask,
  to: SubtaskStatus,
  meta: { actor: SubtaskEvent['actor']; reason?: string; refs?: SubtaskEvent['refs'] },
): SubtaskEvent {
  const from = subtask.status
  const allowed = SUBTASK_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError(`subtask ${subtask.id}: illegal transition ${from} → ${to}`)
  }
  const event: SubtaskEvent = {
    id: `sev_${randomId()}`,
    at: Date.now(),
    from,
    to,
    actor: meta.actor,
    ...(meta.reason === undefined ? {} : { reason: meta.reason }),
    ...(meta.refs === undefined ? {} : { refs: meta.refs }),
  }
  subtask.status = to
  subtask.history.push(event)
  trimEvents(subtask.history)
  return event
}

/** 子任务非状态事件（进度便签、证据提交明细等，kind 区分渲染）。 */
export function appendSubtaskNote(
  subtask: Subtask,
  meta: { actor: SubtaskEvent['actor']; reason?: string; kind: string; refs?: SubtaskEvent['refs'] },
): SubtaskEvent {
  const event: SubtaskEvent = {
    id: `sev_${randomId()}`,
    at: Date.now(),
    from: subtask.status,
    to: subtask.status,
    actor: meta.actor,
    ...(meta.reason === undefined ? {} : { reason: meta.reason }),
    kind: meta.kind,
    ...(meta.refs === undefined ? {} : { refs: meta.refs }),
  }
  subtask.history.push(event)
  trimEvents(subtask.history)
  return event
}

/** 任务级非状态事件（进度便签等）。 */
export function appendTaskNote(
  task: Task,
  meta: { actor: TaskEvent['actor']; reason?: string; kind: string; refs?: TaskEvent['refs'] },
): TaskEvent {
  const event: TaskEvent = {
    id: `ev_${randomId()}`,
    at: Date.now(),
    from: task.status,
    to: task.status,
    actor: meta.actor,
    ...(meta.reason === undefined ? {} : { reason: meta.reason }),
    kind: meta.kind,
    ...(meta.refs === undefined ? {} : { refs: meta.refs }),
  }
  task.events.push(event)
  trimEvents(task.events)
  return event
}

/** NFR-05：事件有界，超出截断最旧者（保留一个截断标记事件的语义由 UI 呈现「更早事件已截断」）。 */
function trimEvents<E extends { id: string }>(events: E[]): void {
  if (events.length > MAX_EVENTS_PER_TASK) {
    events.splice(0, events.length - MAX_EVENTS_PER_TASK)
  }
}

/**
 * T5 守卫：全部子任务已提交证据或已被批准，且无未决工作。
 * （空子任务列表不满足——任务必须先拆解。）
 */
export function allSubtasksEvidencedOrDone(task: Task): boolean {
  if (task.subtasks.length === 0) return false
  return task.subtasks.every(
    sub => (sub.status === 'review' || sub.status === 'done') && (sub.status === 'done' || sub.evidence !== undefined),
  )
}

/** 任务是否存在运行中/排队/受阻的子任务（决定 blocked 语义与 retry 去向）。 */
export function hasActiveSubtasks(task: Task): boolean {
  return task.subtasks.some(
    sub => sub.status === 'pending' || sub.status === 'in-progress' || sub.status === 'blocked' || sub.status === 'rejected',
  )
}
