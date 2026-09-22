import { describe, expect, it } from 'vitest'
import {
  boardGroups,
  cardSummary,
  columnOf,
  filterTasks,
  modelForSession,
  pendingApprovalCount,
  pendingApprovalsOf,
  phaseTimeline,
  progressRatio,
  reviewBadgeCount,
  relativeTime,
  statusLabel,
  subtaskStatusLabel,
  subtaskTimeline,
  subtaskWait,
  reportStats,
  dagLayout,
  dagPhases,
  truncateForDag,
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
    // §4.6：子任务 review = 执行举证完毕（不再逐个人验），与 done 同计入执行进度
    expect(summary.doneCount).toBe(2)
    expect(summary.totalCount).toBe(2)
    expect(summary.awaitingHuman).toBe('review')
    expect(progressRatio(summary)).toBeCloseTo(1)

    const blocked = cardSummary(mkTask({ status: 'blocked', events: [{ id: 'x', at: 1, from: 'in-progress', to: 'blocked', actor: 'system', reason: '拆解失败' }] }))
    expect(blocked.awaitingHuman).toBe('blocked')
    expect(blocked.blockedReason).toBe('拆解失败')
  })

  it('子任务状态标签（§4.6）：review 读作「举证完毕」而非「待验收」', () => {
    expect(subtaskStatusLabel('review')).toBe('举证完毕')
    expect(subtaskStatusLabel('done')).toBe('已批准')
    expect(subtaskStatusLabel('pending')).toBe('排队')
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

describe('节点轨迹（三期：历史内嵌流程图，升序 = 最新在末尾）', () => {
  it('子任务轨迹升序 + 标签可读 + 批语保留', () => {
    const sub = mkSubtask({
      history: [
        { id: 'sa', at: 300, from: null, to: 'pending', actor: 'system' },
        { id: 'sb', at: 500, from: 'review', to: 'rejected', actor: 'human', reason: '缺边界测试' },
      ],
    })
    const timeline = subtaskTimeline(sub)
    expect(timeline.map(e => e.id)).toEqual(['sa', 'sb'])
    expect(timeline[1]!.detail).toBe('缺边界测试')
    expect(timeline[1]!.label).toContain('被打回')
  })

  it('相位轨迹分流：拆解/终检各归其位，终批兜底其余任务事件（零盲区）', () => {
    const task = mkTask({
      events: [
        { id: 'e1', at: 100, from: null, to: 'draft', actor: 'human' },
        { id: 'e2', at: 200, from: 'draft', to: 'decomposing', actor: 'human' },
        { id: 'e3', at: 300, from: 'decomposing', to: 'ready', actor: 'system', kind: 'subtasks-edited', reason: '人工编辑拆解结果' },
        { id: 'e4', at: 400, from: 'in-progress', to: 'in-progress', actor: 'system', kind: 'final-check-started', reason: 'AI 终检开始' },
        { id: 'e5', at: 500, from: 'in-progress', to: 'review', actor: 'system', reason: 'T5' },
        { id: 'e6', at: 600, from: 'review', to: 'in-progress', actor: 'human', kind: 'reject', reason: '打回批语：补测试（AI 定位返工范围中）' },
      ],
    })
    expect(phaseTimeline(task, 'decompose').map(e => e.id)).toEqual(['e2', 'e3'])
    expect(phaseTimeline(task, 'finalcheck').map(e => e.id)).toEqual(['e4'])
    const accept = phaseTimeline(task, 'accept')
    expect(accept.map(e => e.id)).toEqual(['e1', 'e5', 'e6'])
    expect(accept.find(e => e.id === 'e6')?.detail).toContain('打回批语')
    expect(accept.find(e => e.id === 'e5')?.label).toBe('实现中 → 待验收')
    expect(statusLabel('in-progress')).toBe('实现中')
  })

  it('非状态事件（进度）有可读标签，任务级记录落入终批兜底桶', () => {
    const task = mkTask({
      events: [{ id: 'p', at: 1, from: 'in-progress', to: 'in-progress', actor: 'ai', kind: 'progress', reason: '写测试中' }],
    })
    const [entry] = phaseTimeline(task, 'accept')
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

describe('权限审批视图模型（§7.1b）', () => {
  function taskWithApproval(statuses: Array<'pending' | 'elevated' | 'rejected' | 'expired'>) {
    return mkTask({
      subtasks: [
        {
          id: 'tf_1_s1',
          title: '采集系统信息',
          detail: '',
          acceptance: [{ id: 'ac_1', text: '输出采集报告' }],
          deps: [],
          status: 'in-progress',
          round: 1,
          history: [],
          sessionIds: [],
          attempt: 1,
          evidenceHistory: [],
          progressNotes: [],
        },
      ],
      approvals: statuses.map((status, i) => ({
        id: `ap_${i}`,
        subtaskId: 'tf_1_s1',
        sessionId: `tfs_s${i}`,
        toolName: 'write',
        reason: '需要写入文件',
        status,
        createdAt: 1_000 + i,
      })),
    })
  }

  it('pendingApprovalsOf：只投影 pending 并带上子任务标题', () => {
    const task = taskWithApproval(['pending', 'elevated', 'pending'])
    const pending = pendingApprovalsOf(task)
    expect(pending).toHaveLength(2)
    expect(pending[0]).toMatchObject({ id: 'ap_0', subtaskTitle: '采集系统信息', toolName: 'write', taskId: 'tf_1' })
    expect(pending[1]?.id).toBe('ap_2')
    expect(pendingApprovalCount([task])).toBe(2)
    expect(pendingApprovalCount([mkTask(), task])).toBe(2)
  })

  it('cardSummary：待审批是最优先的人工等待态', () => {
    const withApproval = taskWithApproval(['pending'])
    expect(cardSummary(withApproval).awaitingHuman).toBe('approval')
    const decided = taskWithApproval(['elevated'])
    decided.status = 'review'
    expect(cardSummary(decided).awaitingHuman).toBe('review')
  })
})

describe('模型留痕视图（§PLAN-MODEL）', () => {
  it('时间线条目透出 refs.model', () => {
    const task = mkTask({
      events: [
        { id: 'e1', at: 100, from: null, to: 'draft', actor: 'human' },
        {
          id: 'e2',
          at: 200,
          from: 'draft',
          to: 'decomposing',
          actor: 'human',
          refs: { sessionId: 'tfs_d1', model: 'deepseek/deepseek-reasoner·high' },
        },
      ],
      subtasks: [
        {
          id: 'tf_1_s1',
          title: '子任务 A',
          detail: 'd',
          deps: [],
          acceptance: [],
          status: 'in-progress',
          round: 1,
          attempt: 1,
          progressNotes: [],
          evidenceHistory: [],
          history: [
            {
              id: 'sev1',
              at: 300,
              from: null,
              to: 'pending',
              actor: 'system',
            },
            {
              id: 'sev2',
              at: 400,
              from: 'pending',
              to: 'in-progress',
              actor: 'system',
              refs: { sessionId: 'tfs_s1', model: 'ollama/qwen3:8b' },
            },
          ],
        } as unknown as Subtask,
      ],
    })
    const decompose = phaseTimeline(task, 'decompose')
    expect(decompose.find(entry => entry.id === 'e2')?.model).toBe('deepseek/deepseek-reasoner·high')
    const subEntries = subtaskTimeline(task.subtasks[0] as Subtask)
    expect(subEntries.find(entry => entry.id === 'sev2')?.model).toBe('ollama/qwen3:8b')
    expect(subEntries.find(entry => entry.id === 'sev1')?.model).toBeUndefined()
  })

  it('modelForSession：按 sessionId 反查最近一次留痕', () => {
    const sub = {
      id: 'tf_1_s1',
      title: 's',
      detail: '',
      deps: [],
      acceptance: [],
      status: 'review',
      round: 1,
      attempt: 1,
      progressNotes: [],
      evidenceHistory: [],
      history: [
        { id: 'a', at: 1, from: null, to: 'pending', actor: 'system', refs: { sessionId: 'tfs_old', model: 'old/model' } },
        { id: 'b', at: 2, from: 'pending', to: 'in-progress', actor: 'system', refs: { sessionId: 'tfs_new' } },
        { id: 'c', at: 3, from: 'in-progress', to: 'in-progress', actor: 'system', refs: { sessionId: 'tfs_new', model: 'new/model' } },
      ],
    } as unknown as Subtask
    expect(modelForSession(sub, 'tfs_new')).toBe('new/model')
    expect(modelForSession(sub, 'tfs_old')).toBe('old/model')
    expect(modelForSession(sub, 'tfs_missing')).toBeUndefined()
  })
})

describe('卡片 awaitingHuman：权限确认只看当前状态（2026-09-12 真机回归）', () => {
  /** 含一次历史确权等待事件的任务。 */
  function mkTaskWithAwaitingEvent(overrides: Partial<Task> = {}): Task {
    return mkTask({
      events: [
        { id: 'e1', at: 100, from: null, to: 'draft', actor: 'human' },
        { id: 'e2', at: 200, from: 'draft', to: 'in-progress', actor: 'system' },
        { id: 'e3', at: 300, from: 'in-progress', to: 'in-progress', actor: 'system', kind: 'awaiting-permission-confirm' },
        { id: 'e4', at: 400, from: 'in-progress', to: 'in-progress', actor: 'human', kind: 'permission-confirmed' },
        { id: 'e5', at: 500, from: 'in-progress', to: 'done', actor: 'human' },
      ],
      ...overrides,
    })
  }

  it('已终态（done）任务：即使事件史留过 await 痕，也不显示「执行需确认」', () => {
    const card = cardSummary(mkTaskWithAwaitingEvent({ status: 'done', permissionConfirmed: true }))
    expect(card.awaitingHuman).toBeUndefined()
  })

  it('review 态任务：await 痕不干扰「待验收」提示', () => {
    const card = cardSummary(mkTaskWithAwaitingEvent({ status: 'review', permissionConfirmed: true }))
    expect(card.awaitingHuman).toBe('review')
  })

  it('真正在等确认（in-progress 且未确认）才显示「执行需确认」', () => {
    const card = cardSummary(mkTaskWithAwaitingEvent({ status: 'in-progress', permissionConfirmed: false }))
    expect(card.awaitingHuman).toBe('permission')
  })

  it('in-progress 但已确认过：不再显示「执行需确认」', () => {
    const card = cardSummary(mkTaskWithAwaitingEvent({ status: 'in-progress', permissionConfirmed: true }))
    expect(card.awaitingHuman).toBeUndefined()
  })
})

// —— 队列可视化（FR-13：排队/等依赖） ——

describe('subtaskWait（排队原因投影）', () => {
  it('依赖未完成 → 等依赖（列出阻塞者标题）；未知 dep 视为未满足', () => {
    const s1 = mkSubtask({ id: 's1', title: '地基', status: 'in-progress', sessionId: 'sess-a' })
    const s2 = mkSubtask({ id: 's2', title: '楼房', deps: ['s1'], status: 'pending', sessionId: undefined })
    const task = mkTask({ subtasks: [s1, s2] })
    expect(subtaskWait(task, s2)).toEqual({ kind: 'deps', blockers: ['地基'] })

    const s3 = mkSubtask({ id: 's3', title: '幽灵', deps: ['s404'], status: 'pending', sessionId: undefined })
    expect(subtaskWait(task, s3)).toEqual({ kind: 'deps', blockers: ['s404'] })
  })

  it('依赖全 done 或举证完毕（review）→ 等 WIP 空位；无依赖同样排队', () => {
    const s1 = mkSubtask({ id: 's1', title: '地基', status: 'done' })
    const s2 = mkSubtask({ id: 's2', title: '楼房', deps: ['s1'], status: 'pending', sessionId: undefined })
    const s3 = mkSubtask({ id: 's3', title: '独立', deps: [], status: 'pending', sessionId: undefined })
    const s4 = mkSubtask({ id: 's4', title: '装修', deps: ['s2'], status: 'pending', sessionId: undefined })
    const task = mkTask({ subtasks: [s1, s2, s3, s4] })
    s2.status = 'review' // 举证完毕 = 产物已存在，不再是下游的阻塞者
    expect(subtaskWait(task, s3)).toEqual({ kind: 'wip', blockers: [] })
    expect(subtaskWait(task, s4)).toEqual({ kind: 'wip', blockers: [] })
  })

  it('非排队态（运行中/举证完毕/已批准）与非执行中任务 → undefined', () => {
    const s1 = mkSubtask({ id: 's1', title: '运行中', status: 'in-progress', sessionId: 'sess-a', deps: [] })
    const s2 = mkSubtask({ id: 's2', title: '举证完毕', status: 'review', deps: [] })
    const s3 = mkSubtask({ id: 's3', title: '已批准', status: 'done', deps: [] })
    const task = mkTask({ subtasks: [s1, s2, s3] })
    expect(subtaskWait(task, s1)).toBeUndefined()
    expect(subtaskWait(task, s2)).toBeUndefined()
    expect(subtaskWait(task, s3)).toBeUndefined()

    const reviewTask = mkTask({ status: 'review', subtasks: [mkSubtask({ status: 'pending' })] })
    expect(subtaskWait(reviewTask, reviewTask.subtasks[0]!)).toBeUndefined()
  })
})

// —— DAG 流程图投影（FR-12 可视化：分层布局） ——

describe('dagLayout（子任务 DAG 分层）', () => {
  it('链式与菱形依赖：最长路径分层（后序层号 = max(依赖层)+1）', () => {
    // 菱形：s1 → s2/s3 → s4（s4 必须落在 s2、s3 之下）
    const task = mkTask({
      subtasks: [
        mkSubtask({ id: 's1', deps: [] }),
        mkSubtask({ id: 's2', deps: ['s1'] }),
        mkSubtask({ id: 's3', deps: ['s1'] }),
        mkSubtask({ id: 's4', deps: ['s2', 's3'] }),
      ],
    })
    const layout = dagLayout(task)
    const layerOf = new Map(layout.nodes.map(n => [n.sub.id, n.layer]))
    expect(layerOf.get('s1')).toBe(0)
    expect(layerOf.get('s2')).toBe(1)
    expect(layerOf.get('s3')).toBe(1)
    expect(layerOf.get('s4')).toBe(2)
    expect(layout.layerCount).toBe(3)
    expect(layout.layerSizes).toEqual([1, 2, 1])
    // 同层内按拆解顺序纵排（index 稳定）
    const s2 = layout.nodes.find(n => n.sub.id === 's2')!
    const s3 = layout.nodes.find(n => n.sub.id === 's3')!
    expect(s2.index).toBe(0)
    expect(s3.index).toBe(1)
    // 边 = 每条 dep 一条，方向 from dep → to 依赖者
    expect(layout.edges).toHaveLength(4)
    expect(layout.edges).toContainEqual({ from: 's2', to: 's4', missing: false })
    expect(layout.edges).toContainEqual({ from: 's3', to: 's4', missing: false })
  })

  it('平铺无依赖：全部 0 层单列；等待原因投影进节点', () => {
    const s1 = mkSubtask({ id: 's1', title: '独立甲', status: 'pending', sessionId: undefined })
    const s2 = mkSubtask({ id: 's2', title: '独立乙', status: 'in-progress', sessionId: 'sess-a' })
    const task = mkTask({ subtasks: [s1, s2] })
    const layout = dagLayout(task)
    expect(layout.layerCount).toBe(1)
    expect(layout.layerSizes).toEqual([2])
    expect(layout.edges).toHaveLength(0)
    // 平铺排队 → 等 WIP 空位；运行中 → 无等待
    const n1 = layout.nodes.find(n => n.sub.id === 's1')!
    const n2 = layout.nodes.find(n => n.sub.id === 's2')!
    expect(n1.wait).toEqual({ kind: 'wip', blockers: [] })
    expect(n2.wait).toBeUndefined()
  })

  it('孤儿 dep 不参与分层、边标 missing；未知依赖者仍从 0 层起排', () => {
    const task = mkTask({
      subtasks: [
        mkSubtask({ id: 's1', deps: [] }),
        mkSubtask({ id: 's2', deps: ['s404'] }),
        mkSubtask({ id: 's3', deps: ['s2'] }),
      ],
    })
    const layout = dagLayout(task)
    const layerOf = new Map(layout.nodes.map(n => [n.sub.id, n.layer]))
    expect(layerOf.get('s2')).toBe(0) // s404 不存在，不抬层
    expect(layerOf.get('s3')).toBe(1)
    expect(layout.edges).toContainEqual({ from: 's404', to: 's2', missing: true })
    expect(layout.edges).toContainEqual({ from: 's2', to: 's3', missing: false })
  })

  it('异常环边防御：不无限抬层（收敛上限内停止，布局退化不崩）', () => {
    // add/edit 已校验无环；手工改库等异常形态下不得死循环/抛错
    const task = mkTask({
      subtasks: [
        mkSubtask({ id: 's1', deps: ['s2'] }),
        mkSubtask({ id: 's2', deps: ['s1'] }),
      ],
    })
    const layout = dagLayout(task)
    expect(layout.nodes).toHaveLength(2)
    // 收敛防御的合同：有界（≤ 2×节点数）、不抛错、不悬挂
    for (const node of layout.nodes) {
      expect(node.layer).toBeGreaterThanOrEqual(0)
      expect(node.layer).toBeLessThanOrEqual(task.subtasks.length * 2)
    }
  })
})

describe('truncateForDag（SVG 单行截断）', () => {
  it('不超长原样返回；CJK 按双宽计，超长加省略号', () => {
    expect(truncateForDag('短标题', 10)).toBe('短标题')
    expect(truncateForDag('实现用户登录模块', 10)).toBe('实现用户…')
    expect(truncateForDag('abcdefghijk', 8)).toBe('abcdef…')
    expect(truncateForDag('', 5)).toBe('')
  })
})

describe('dagPhases（任务管线相位：拆解 → 终检 → 终批）', () => {
  it('拆解中：拆解 = 运行中，终检/终批 = 等待', () => {
    const task = mkTask({ status: 'decomposing' })
    const [decompose, finalcheck, accept] = dagPhases(task)
    expect(decompose).toMatchObject({ id: 'decompose', status: 'in-progress' })
    expect(decompose.line).toContain('拆解会话运行中')
    expect(finalcheck).toMatchObject({ id: 'finalcheck', status: 'pending' })
    expect(accept).toMatchObject({ id: 'accept', status: 'pending' })
  })

  it('draft 未开始：拆解 = 待开始；跑过拆解会话 = 完成', () => {
    const [decompose] = dagPhases(mkTask({ status: 'draft' }))
    expect(decompose).toMatchObject({ status: 'pending' })
    expect(decompose.line).toContain('待开始')
    const [done] = dagPhases(mkTask({ status: 'in-progress', decomposeSessionIds: ['sess-d'] }))
    expect(done).toMatchObject({ status: 'done' })
  })

  it('终检：会话运行中 = 运行；证据产出或任务终态 = 完成', () => {
    const running = dagPhases(mkTask({ status: 'in-progress', finalizeSessionId: 'sess-f' }))[1]!
    expect(running).toMatchObject({ id: 'finalcheck', status: 'in-progress' })
    const evidence = {
      submittedAt: 1,
      changesSummary: 's',
      verification: [],
      selfCheck: [],
      refs: { sessionId: 'sess-f' },
    }
    const withEvidence = dagPhases(mkTask({ status: 'review', evidence }))[1]!
    expect(withEvidence).toMatchObject({ id: 'finalcheck', status: 'done' })
    const terminal = dagPhases(mkTask({ status: 'done' }))[1]!
    expect(terminal).toMatchObject({ id: 'finalcheck', status: 'done' })
  })

  it('终批：review = 等人；done = 通过；cancelled = 已取消', () => {
    const review = dagPhases(mkTask({ status: 'review' }))[2]!
    expect(review).toMatchObject({ id: 'accept', status: 'review', line: '等待人工终批' })
    const done = dagPhases(mkTask({ status: 'done' }))[2]!
    expect(done).toMatchObject({ status: 'done', line: '验收通过' })
    const cancelled = dagPhases(mkTask({ status: 'cancelled' }))[2]!
    expect(cancelled).toMatchObject({ status: 'blocked', line: '任务已取消' })
  })
})

// —— 周期统计（FR-20） ——

describe('reportStats（吞吐 / 一次通过率 / 平均迭代轮次 / 拆解采纳率）', () => {
  const day = 24 * 60 * 60_000
  const now = 1_000_000_000_000

  function doneTask(overrides: Partial<Task> = {}): Task {
    return mkTask({
      status: 'done',
      events: [
        { id: 'd1', at: now - 3 * day, from: 'review', to: 'done', actor: 'human' },
      ],
      subtasks: [mkSubtask()],
      ...overrides,
    })
  }

  it('空账本：比率与均值为 null（不编造 0%）', () => {
    const stats = reportStats([], now)
    expect(stats.doneTotal).toBe(0)
    expect(stats.firstPassRate).toBeNull()
    expect(stats.avgRounds).toBeNull()
    expect(stats.decomposeAdoptionRate).toBeNull()
  })

  it('吞吐按 done 事件时间分桶；一次通过率 = round=1 占比', () => {
    const recent = doneTask() // 3 天前 done，round 1
    const older = doneTask({
      events: [{ id: 'd2', at: now - 20 * day, from: 'review', to: 'done', actor: 'human' }],
      round: 2, // 被打回过一次
    })
    const stats = reportStats([recent, older], now)
    expect(stats.doneTotal).toBe(2)
    expect(stats.doneLast7d).toBe(1)
    expect(stats.doneLast30d).toBe(2)
    expect(stats.firstPassRate).toBe(0.5)
    expect(stats.avgRounds).toBe(1.5)
    expect(stats.reworkedCount).toBe(1)
  })

  it('拆解采纳率：未发生 subtasks-edited 的拆解任务占比', () => {
    const untouched = doneTask()
    const edited = doneTask({ round: 1, events: [
      { id: 'd3', at: now - day, from: 'review', to: 'done', actor: 'human' },
      { id: 'd4', at: now - 2 * day, from: 'in-progress', to: 'in-progress', actor: 'human', kind: 'subtasks-edited' },
    ] })
    const stats = reportStats([untouched, edited], now)
    expect(stats.decomposeAdoptionRate).toBe(0.5)
  })

  it('归档的 done 任务仍计入（曾经完成过）；进行中口径不含 done/cancelled', () => {
    const archivedDone = doneTask({ status: 'archived' })
    const active = mkTask({ status: 'in-progress', subtasks: [mkSubtask()] })
    const cancelled = mkTask({ status: 'cancelled', subtasks: [mkSubtask()] })
    const stats = reportStats([archivedDone, active, cancelled], now)
    expect(stats.doneTotal).toBe(1)
    expect(stats.activeCount).toBe(1)
  })
})
