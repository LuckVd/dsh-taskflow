import { describe, expect, it } from 'vitest'
import {
  boardGroups,
  cardSummary,
  columnOf,
  filterTasks,
  mergedTimeline,
  progressRatio,
  reviewBadgeCount,
  relativeTime,
  statusLabel,
} from '../../src/client/view.ts'
import type { Subtask, Task } from '../../src/protocol/types.ts'

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tf_1',
    title: '修复登录 500',
    description: '登录接口偶发 500',
    contract: {
      objective: 'o',
      acceptance: [{ id: 'ac_1', text: '测试通过' }],
      sourceOfAcceptance: 'human',
      pins: { workspace: '/tmp', presetId: null, permission: 'read-only' },
    },
    status: 'in-progress',
    subtasks: [],
    events: [
      { id: 'e1', at: 100, from: null, to: 'draft', actor: 'human' },
      { id: 'e2', at: 200, from: 'draft', to: 'decomposing', actor: 'human' },
    ],
    round: 1,
    maxRounds: 3,
    createdAt: 100,
    updatedAt: 200,
    createdBy: 'human',
    autoStart: true,
    permissionConfirmed: true,
    decomposeSessionIds: [],
    ...overrides,
  }
}

function mkSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: 'tf_1_s1',
    title: '实现核心逻辑',
    detail: 'd',
    acceptance: [{ id: 'ac_2', text: 'a' }],
    deps: [],
    status: 'done',
    round: 1,
    history: [{ id: 's1', at: 300, from: null, to: 'pending', actor: 'system' }],
    sessionIds: ['sess-1'],
    attempt: 1,
    evidenceHistory: [],
    progressNotes: [],
    ...overrides,
  }
}

describe('视图模型：看板分组与摘要', () => {
  it('四列分组覆盖全部状态；archived 不出现在主视图', () => {
    const tasks = [
      mkTask({ id: 'a', status: 'draft' }),
      mkTask({ id: 'b', status: 'in-progress' }),
      mkTask({ id: 'c', status: 'review' }),
      mkTask({ id: 'd', status: 'done' }),
      mkTask({ id: 'e', status: 'archived' }),
      mkTask({ id: 'f', status: 'blocked' }),
      mkTask({ id: 'g', status: 'decomposing' }),
      mkTask({ id: 'h', status: 'ready' }),
    ]
    const groups = boardGroups(tasks)
    expect(groups.map(g => g.id)).toEqual(['todo', 'inProgress', 'review', 'done'])
    const ids = groups.flatMap(g => g.cards.map(c => c.task.id))
    expect(ids).not.toContain('e')
    // blocked 回到原列（待办/实现中列内标红，§4.9）
    expect(columnOf('blocked', true)).toBe('inProgress')
    expect(columnOf('blocked', false)).toBe('todo')
    expect(ids).toContain('f')
  })

  it('卡片摘要：进度、轮次、受阻原因、待人工动作', () => {
    const task = mkTask({
      status: 'review',
      round: 2,
      subtasks: [mkSubtask({ status: 'done' }), mkSubtask({ status: 'review' })],
      events: [
        ...mkTask().events,
        { id: 'e3', at: 400, from: 'in-progress', to: 'review', actor: 'system', reason: 'T5' },
      ],
    })
    const summary = cardSummary(task)
    expect(summary.doneCount).toBe(1)
    expect(summary.totalCount).toBe(2)
    expect(summary.awaitingHuman).toBe('review')
    expect(progressRatio(summary)).toBeCloseTo(0.5)

    const blocked = cardSummary(mkTask({ status: 'blocked', events: [{ id: 'x', at: 1, from: 'in-progress', to: 'blocked', actor: 'system', reason: '拆解失败' }] }))
    expect(blocked.awaitingHuman).toBe('blocked')
    expect(blocked.blockedReason).toBe('拆解失败')
  })

  it('lastActivity 取任务与子任务事件的最新值', () => {
    const task = mkTask({ updatedAt: 200, subtasks: [mkSubtask({ history: [{ id: 's', at: 999, from: 'pending', to: 'in-progress', actor: 'system' }] })] })
    expect(cardSummary(task).lastActivity).toBe(999)
  })
})

describe('过滤与角标', () => {
  const tasks = [
    mkTask({ id: 'a', title: '登录修复', description: 'desc', status: 'review' }),
    mkTask({ id: 'b', title: '报表', description: '报表导出', status: 'done' }),
    mkTask({
      id: 'c',
      title: '其他',
      description: 'x',
      status: 'in-progress',
      subtasks: [mkSubtask({ title: '登录子任务' })],
    }),
  ]

  it('搜索覆盖标题/描述/子任务（US-13）', () => {
    expect(filterTasks(tasks, { query: '登录' }).map(t => t.id)).toEqual(['a', 'c'])
    expect(filterTasks(tasks, { query: '报表' }).map(t => t.id)).toEqual(['b'])
  })

  it('状态过滤', () => {
    expect(filterTasks(tasks, { status: 'active' }).map(t => t.id)).toEqual(['a', 'c'])
    expect(filterTasks(tasks, { status: 'review' }).map(t => t.id)).toEqual(['a'])
    expect(filterTasks(tasks, { status: 'all' })).toHaveLength(3)
  })

  it('待验收角标数（US-15 M1 形态）', () => {
    expect(reviewBadgeCount(tasks)).toBe(1)
  })
})

describe('时间线合并（US-09）', () => {
  it('任务级 + 子任务级事件按时间倒序、标签可读、批语保留', () => {
    const task = mkTask({
      subtasks: [
        mkSubtask({
          history: [
            { id: 'sa', at: 300, from: null, to: 'pending', actor: 'system' },
            { id: 'sb', at: 500, from: 'review', to: 'rejected', actor: 'human', reason: '缺边界测试' },
          ],
        }),
      ],
      events: [
        { id: 'e1', at: 100, from: null, to: 'draft', actor: 'human' },
        { id: 'e4', at: 600, from: 'review', to: 'in-progress', actor: 'human', reason: '打回：补测试（T7）' },
      ],
    })
    const timeline = mergedTimeline(task)
    expect(timeline.map(e => e.id)).toEqual(['e4', 'sb', 'sa', 'e1'])
    expect(timeline[1]!.detail).toBe('缺边界测试')
    expect(timeline[1]!.label).toContain('被打回')
    expect(timeline[0]!.label).toBe('待验收 → 实现中')
    expect(statusLabel('in-progress')).toBe('实现中')
  })

  it('非状态事件（进度/证据/恢复）有可读标签', () => {
    const task = mkTask({
      events: [{ id: 'p', at: 1, from: 'in-progress', to: 'in-progress', actor: 'ai', kind: 'progress', reason: '写测试中' }],
    })
    const [entry] = mergedTimeline(task)
    expect(entry.label).toBe('进度')
    expect(entry.isTransition).toBe(false)
  })
})

describe('相对时间', () => {
  it('档位', () => {
    const now = 1_000_000_000
    expect(relativeTime(now - 30_000, now)).toBe('刚刚')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 天前')
  })
})
