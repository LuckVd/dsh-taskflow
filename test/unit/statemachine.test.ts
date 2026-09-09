import { describe, expect, it } from 'vitest'
import {
  SUBTASK_TRANSITIONS,
  TASK_TRANSITIONS,
  IllegalTransitionError,
  allSubtasksEvidencedOrDone,
  transitionSubtask,
  transitionTask,
} from '../../src/host/statemachine.ts'
import type { Subtask, Task } from '../../src/protocol/types.ts'

function draftTask(status: Task['status']): Task {
  return {
    id: 'tf_t',
    title: 't',
    description: 'd',
    contract: { objective: 'o', acceptance: [], sourceOfAcceptance: 'human', pins: { workspace: '/tmp', presetId: null, permission: 'read-only' } },
    status,
    subtasks: [],
    events: [],
    round: 1,
    maxRounds: 3,
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'human',
    autoStart: true,
    permissionConfirmed: true,
    decomposeSessionIds: [],
  }
}

function draftSubtask(status: Subtask['status']): Subtask {
  return {
    id: 'tf_t_s1',
    title: 's',
    detail: '',
    acceptance: [{ id: 'ac_1', text: 'x' }],
    deps: [],
    status,
    round: 1,
    history: [],
    sessionIds: [],
    attempt: 0,
    evidenceHistory: [],
    progressNotes: [],
  }
}

describe('状态机转移表（FUNCTIONS.md §3）', () => {
  it('任务级：合法转移逐项可达（T1–T10 全覆盖）', () => {
    const legal: Array<[Task['status'], Task['status'], string]> = [
      ['draft', 'decomposing', 'T2'],
      ['decomposing', 'ready', 'T3'],
      ['decomposing', 'blocked', "T3'"],
      ['ready', 'in-progress', 'T4'],
      ['in-progress', 'review', 'T5'],
      ['in-progress', 'blocked', 'T8'],
      ['review', 'done', 'T6'],
      ['review', 'in-progress', 'T7'],
      ['review', 'blocked', "T7'"],
      ['blocked', 'decomposing', '重新拆解'],
      ['blocked', 'in-progress', '解除阻塞'],
      ['done', 'archived', 'T10'],
      ['cancelled', 'archived', 'T10'],
    ]
    for (const [from, to, label] of legal) {
      const task = draftTask(from)
      expect(() => transitionTask(task, to, { actor: 'human' }), `${label}: ${from}→${to}`).not.toThrow()
      expect(task.status).toBe(to)
      expect(task.events.at(-1)?.from).toBe(from)
      expect(task.events.at(-1)?.to).toBe(to)
    }
    for (const from of ['draft', 'decomposing', 'ready', 'in-progress', 'review', 'blocked'] as const) {
      const task = draftTask(from)
      transitionTask(task, 'cancelled', { actor: 'human' })
      expect(task.status, `T9: ${from}→cancelled`).toBe('cancelled')
    }
  })

  it('任务级：非法转移抛 IllegalTransitionError', () => {
    const illegal: Array<[Task['status'], Task['status']]> = [
      ['draft', 'ready'],
      ['draft', 'in-progress'],
      ['ready', 'review'],
      ['ready', 'decomposing'],
      ['in-progress', 'done'],
      ['in-progress', 'archived'],
      ['review', 'ready'],
      ['done', 'in-progress'],
      ['done', 'cancelled'],
      ['cancelled', 'in-progress'],
      ['archived', 'draft'],
    ]
    for (const [from, to] of illegal) {
      const task = draftTask(from)
      expect(() => transitionTask(task, to, { actor: 'system' }), `${from}→${to}`).toThrow(IllegalTransitionError)
      expect(task.status).toBe(from)
    }
  })

  it('子任务级：合法转移（S1–S6）', () => {
    const legal: Array<[Subtask['status'], Subtask['status'], string]> = [
      ['pending', 'in-progress', 'S2'],
      ['in-progress', 'review', 'S3'],
      ['in-progress', 'blocked', 'S6'],
      ['review', 'done', 'S4'],
      ['review', 'rejected', 'S5a'],
      ['rejected', 'in-progress', 'S5b'],
      ['blocked', 'pending', '人工重试'],
      ['blocked', 'done', '人工强制完成'],
      ['pending', 'blocked', '依赖无法满足'],
    ]
    for (const [from, to, label] of legal) {
      const sub = draftSubtask(from)
      expect(() => transitionSubtask(sub, to, { actor: 'system' }), `${label}: ${from}→${to}`).not.toThrow()
    }
  })

  it('子任务级：非法转移拒绝', () => {
    const illegal: Array<[Subtask['status'], Subtask['status']]> = [
      ['pending', 'done'],
      ['pending', 'review'],
      ['in-progress', 'done'],
      ['review', 'in-progress'],
      ['done', 'in-progress'],
      ['done', 'review'],
      ['rejected', 'done'],
    ]
    for (const [from, to] of illegal) {
      const sub = draftSubtask(from)
      expect(() => transitionSubtask(sub, to, { actor: 'ai' }), `${from}→${to}`).toThrow(IllegalTransitionError)
    }
  })

  it('转移表声明与文档表格一致（防漂移快照）', () => {
    expect(TASK_TRANSITIONS).toMatchObject({
      draft: ['decomposing', 'cancelled'],
      decomposing: ['ready', 'blocked', 'cancelled'],
      ready: ['in-progress', 'cancelled'],
      'in-progress': ['review', 'blocked', 'cancelled'],
      review: ['done', 'in-progress', 'blocked', 'cancelled'],
      blocked: ['decomposing', 'in-progress', 'review', 'ready', 'cancelled'],
      done: ['archived'],
      cancelled: ['archived'],
      archived: [],
    })
    expect(SUBTASK_TRANSITIONS).toMatchObject({
      pending: ['in-progress', 'blocked'],
      'in-progress': ['review', 'blocked'],
      review: ['done', 'rejected'],
      rejected: ['in-progress'],
      done: [],
      blocked: ['pending', 'done'],
    })
  })

  it('事件含 actor/reason/refs 且只追加', () => {
    const task = draftTask('draft')
    transitionTask(task, 'decomposing', { actor: 'human', reason: '开始', refs: { sessionId: 's1' } })
    const event = task.events.at(-1)!
    expect(event.actor).toBe('human')
    expect(event.reason).toBe('开始')
    expect(event.refs).toEqual({ sessionId: 's1' })
    const count = task.events.length
    transitionTask(task, 'cancelled', { actor: 'human' })
    expect(task.events).toHaveLength(count + 1)
    expect(task.events[0]!.to).toBe('decomposing')
  })

  it('T5 守卫：全部 review/done 且证据齐全才成立', () => {
    const task = draftTask('in-progress')
    expect(allSubtasksEvidencedOrDone(task)).toBe(false) // 空子任务不满足
    const evidence = {
      submittedAt: 1,
      changesSummary: 's',
      verification: [{ label: 'l', output: 'o', passed: true }],
      selfCheck: [{ acceptanceId: 'ac_1', verdict: 'pass' as const, note: '' }],
      refs: { sessionId: 's' },
    }
    task.subtasks.push({ ...draftSubtask('review'), evidence })
    expect(allSubtasksEvidencedOrDone(task)).toBe(true)
    task.subtasks.push({ ...draftSubtask('pending') })
    expect(allSubtasksEvidencedOrDone(task)).toBe(false)
    task.subtasks[1]!.status = 'done'
    expect(allSubtasksEvidencedOrDone(task)).toBe(true)
  })
})
