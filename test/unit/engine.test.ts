import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_CONFIG, TaskflowEngine } from '../../src/host/engine.ts'
import { LedgerStore } from '../../src/host/ledger.ts'
import type { DispatchResult } from '../../src/host/engine.ts'
import { MockSessionAdapter, buildPassingEvidence } from '../../src/host/mock/session-adapter.ts'
import { cleanup, ledgerOf, subtaskOf, taskOf, tempDir, waitFor } from '../helpers.ts'

function createEngine(file: string, config: Partial<typeof DEFAULT_ENGINE_CONFIG> = {}): {
  engine: TaskflowEngine
  adapter: MockSessionAdapter
} {
  const box: { engine?: TaskflowEngine } = {}
  const adapter = new MockSessionAdapter({ getLedger: () => box.engine!.getState().ledger })
  const engine = new TaskflowEngine(new LedgerStore(file), adapter, { ...DEFAULT_ENGINE_CONFIG, ...config })
  box.engine = engine
  return { engine, adapter }
}

async function createOneWordTask(engine: TaskflowEngine): Promise<string> {
  const result: DispatchResult = await engine.dispatch({
    type: 'createTask',
    requestId: 'req-create',
    title: '修复登录 500',
    description: '登录接口偶发 500，定位并修复，补回归测试。',
  })
  expect(result.ok).toBe(true)
  return result.taskId!
}

/** 等到任务达到目标状态。 */
function statusOf(engine: TaskflowEngine, taskId: string): () => string {
  return () => ledgerOf(engine).tasks.find(t => t.id === taskId)?.status ?? 'missing'
}

describe('引擎：创建 → 拆解 → 执行 → 证据 → 验收', () => {
  it('一句话创建（无验收）→ AI 补全 + 拆解 → 自动开工 → 证据 → 终批 done', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const taskId = await createOneWordTask(engine)

      // 拆解 + 自动开工 + 串行执行 + 全部证据
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      const task = taskOf(engine, taskId)
      expect(task.contract.sourceOfAcceptance).toBe('ai-drafted')
      expect(task.contract.acceptance.length).toBeGreaterThan(0)
      expect(task.subtasks).toHaveLength(2)
      expect(task.subtasks.every(s => s.status === 'review')).toBe(true)
      expect(task.subtasks.every(s => s.evidence !== undefined)).toBe(true)
      // 串行执行：两个会话都启动过
      expect(adapter.executionRuns).toHaveLength(2)

      // 任务级终批
      const approve = await engine.dispatch({ type: 'approveTask', requestId: 'req-approve', taskId })
      expect(approve.ok).toBe(true)
      expect(statusOf(engine, taskId)()).toBe('done')
      expect(taskOf(engine, taskId).subtasks.every(s => s.status === 'done')).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })

  it('requestId 幂等去重（重复提交返回同一结果）', async () => {
    const dir = await tempDir()
    try {
      const { engine } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const first = await engine.dispatch({
        type: 'createTask',
        requestId: 'dup-1',
        title: 'A',
        description: 'desc',
        autoDecompose: false,
      })
      const second = await engine.dispatch({
        type: 'createTask',
        requestId: 'dup-1',
        title: 'B',
        description: 'other',
        autoDecompose: false,
      })
      expect(second.taskId).toBe(first.taskId)
      expect(ledgerOf(engine).tasks).toHaveLength(1)
      expect(ledgerOf(engine).tasks[0]!.title).toBe('A')
    } finally {
      await cleanup(dir)
    }
  })

  it('用户已给验收：AI 只能等长细化并保留原文（FR-02）', async () => {
    const dir = await tempDir()
    try {
      const { engine } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const result = await engine.dispatch({
        type: 'createTask',
        requestId: 'req-ac',
        title: '带验收的任务',
        description: '描述',
        acceptance: [{ text: '用户验收 1' }, { text: '用户验收 2' }],
      })
      const taskId = result.taskId!
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      const task = taskOf(engine, taskId)
      expect(task.contract.sourceOfAcceptance).toBe('ai-refined')
      expect(task.contract.originalHumanAcceptance?.map(a => a.text)).toEqual(['用户验收 1', '用户验收 2'])
      // id 不变（可追溯）
      expect(task.contract.acceptance.map(a => a.text)).toEqual(['用户验收 1', '用户验收 2'])
    } finally {
      await cleanup(dir)
    }
  })

  it('细化不等长 → 拆解失败重试 1 次 → 仍失败 blocked（T3′）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      adapter.decomposeBehavior = () => ({
        kind: 'ok',
        output: {
          taskAcceptance: [{ text: '只给了 1 条细化（用户给了 2 条）' }],
          subtasks: [{ title: 'X', detail: '', acceptance: [{ text: 'x' }], deps: [] }],
        },
      })
      const result = await engine.dispatch({
        type: 'createTask',
        requestId: 'req-bad',
        title: '细化不等长',
        description: '描述',
        acceptance: [{ text: 'A1' }, { text: 'A2' }],
      })
      await waitFor(() => statusOf(engine, result.taskId!)() === 'blocked')
      // 重试 1 次 = 2 次拆解会话
      expect(adapter.decomposeRuns).toHaveLength(2)
      const task = taskOf(engine, result.taskId!)
      expect(task.events.at(-1)?.reason).toContain('拆解失败且重试耗尽')
      // 拆解受阻形态：retryBlocked 必须拒绝（防误入 0 子任务死态），startDecompose 才是恢复路径
      const wrongRetry = await engine.dispatch({ type: 'retryBlocked', requestId: 'req-wrong', taskId: result.taskId! })
      expect(wrongRetry.ok).toBe(false)
      expect(wrongRetry.error).toContain('startDecompose')
      const resumed = await engine.dispatch({ type: 'startDecompose', requestId: 'req-resume', taskId: result.taskId! })
      expect(resumed.ok).toBe(true)
      expect(statusOf(engine, result.taskId!)()).toBe('decomposing')
    } finally {
      await cleanup(dir)
    }
  })

  it('证据缺项被拒：返回结构化修正提示，子任务停留 in-progress（不变量 3）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      adapter.executionBehavior = async input => {
        const ledger = engine.getState().ledger
        const sub = ledger.tasks.flatMap(t => t.subtasks).find(s => s.id === input.subtaskId)!
        // 故意缺一条 selfCheck
        const payload = buildPassingEvidence(ledger, input.subtaskId) as { selfCheck: unknown[] }
        payload.selfCheck = payload.selfCheck.slice(0, -1)
        const rejected = await input.tools.submitEvidence(payload)
        if (!rejected.accepted) {
          expect(rejected.correction).toContain('被拒收')
          expect(rejected.correction).toContain(sub.acceptance.at(-1)!.id)
          // 修正后重新提交完整证据
          const full = buildPassingEvidence(ledger, input.subtaskId)
          const retry = await input.tools.submitEvidence(full)
          if (!retry.accepted) throw new Error(retry.correction)
        }
      }
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      const sub = subtaskOf(engine, taskId, 0)
      expect(sub.status).toBe('review')
      expect(sub.history.some(e => e.kind === undefined && e.to === 'review' && e.from === 'in-progress')).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })

  it('打回：批语必填注入下一轮，round+1，轮次上限 T7′ → 提高上限 → 恢复（T7/T7′/S5/FR-08）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      expect(taskOf(engine, taskId).round).toBe(1)

      // 打回：默认作用域 = 全部 review 子任务（证据全 pass 时）
      const reject = await engine.dispatch({
        type: 'rejectSubtask',
        requestId: 'req-reject-1',
        taskId,
        comment: '测试没有覆盖并发场景，请补并发回归后再提交。',
      })
      expect(reject.ok).toBe(true)
      expect(reject.subtaskIds).toHaveLength(2)
      expect(taskOf(engine, taskId).round).toBe(2)

      // 下一轮执行注入批语原文（§4.7）
      await waitFor(() => adapter.executionRuns.some(r => r.prompt.includes('测试没有覆盖并发场景')))
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      // 第二轮的证据里 round 记录为 2
      expect(subtaskOf(engine, taskId, 0).round).toBe(2)
      expect(subtaskOf(engine, taskId, 0).evidenceHistory).toHaveLength(2)

      // 打回至迭代上限（默认 maxRounds=3，当前 round=2 → 打回后 round=3 允许；再一次触发 T7′）
      await engine.dispatch({ type: 'rejectSubtask', requestId: 'req-reject-2', taskId, comment: '第二轮批语' })
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      const atLimit = await engine.dispatch({ type: 'rejectSubtask', requestId: 'req-reject-3', taskId, comment: '第三轮批语' })
      expect(atLimit.ok).toBe(true)
      await waitFor(() => statusOf(engine, taskId)() === 'blocked')
      expect(taskOf(engine, taskId).events.at(-1)?.reason).toContain('迭代上限')

      // 提高上限 → retryBlocked 恢复验收 → 终批
      await engine.dispatch({ type: 'raiseMaxRounds', requestId: 'req-raise', taskId, maxRounds: 5 })
      await engine.dispatch({ type: 'retryBlocked', requestId: 'req-retry', taskId })
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      const done = await engine.dispatch({ type: 'approveTask', requestId: 'req-approve', taskId })
      expect(done.ok).toBe(true)
      expect(statusOf(engine, taskId)()).toBe('done')
    } finally {
      await cleanup(dir)
    }
  })

  it('子任务会话反复失败：attempt 耗尽 → S6+T8 blocked；人工 retry 恢复', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      adapter.executionBehavior = async () => {
        throw new Error('mock 会话崩溃')
      }
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'blocked')
      const sub = subtaskOf(engine, taskId, 0)
      expect(sub.status).toBe('blocked')
      expect(sub.attempt).toBeGreaterThanOrEqual(2)

      // 人工重试 → 恢复默认行为 → 走完
      adapter.executionBehavior = undefined
      const retry = await engine.dispatch({ type: 'retryBlocked', requestId: 'req-retry', taskId, subtaskId: sub.id })
      expect(retry.ok).toBe(true)
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      await engine.dispatch({ type: 'approveTask', requestId: 'req-approve', taskId })
      expect(statusOf(engine, taskId)()).toBe('done')
    } finally {
      await cleanup(dir)
    }
  })

  it('权限确认门：高于会话默认权限须确认才开工；pins 变更 re-arm（§7.1）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const result = await engine.dispatch({
        type: 'createTask',
        requestId: 'req-perm',
        title: '高权限任务',
        description: '描述',
        pins: { permission: 'workspace-write' },
        autoDecompose: true,
        autoStart: false,
      })
      const taskId = result.taskId!
      await waitFor(() => statusOf(engine, taskId)() === 'ready')
      // 拆解完成但 autoStart=false → 停在 ready
      expect(adapter.executionRuns).toHaveLength(0)

      // 不带 confirm 直接开工 → 拒绝
      const denied = await engine.dispatch({ type: 'startImplementation', requestId: 'req-start-1', taskId })
      expect(denied.ok).toBe(false)
      expect(denied.error).toContain('权限')

      // 带确认 → 开工
      const ok = await engine.dispatch({
        type: 'startImplementation',
        requestId: 'req-start-2',
        taskId,
        confirmPermission: true,
      })
      expect(ok.ok).toBe(true)
      await waitFor(() => statusOf(engine, taskId)() === 'review')
    } finally {
      await cleanup(dir)
    }
  })

  it('取消（T9）尽力终止会话；归档（T10）只读', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      // 让执行会话长时间运行
      adapter.executionBehavior = async () => new Promise(() => {})
      const taskId = await createOneWordTask(engine)
      await waitFor(() => taskOf(engine, taskId).subtasks.some(s => s.status === 'in-progress'))

      const cancel = await engine.dispatch({ type: 'cancelTask', requestId: 'req-cancel', taskId, confirm: true })
      expect(cancel.ok).toBe(true)
      expect(statusOf(engine, taskId)()).toBe('cancelled')
      expect(adapter.cancelled.length).toBeGreaterThan(0)

      const archive = await engine.dispatch({ type: 'archiveTask', requestId: 'req-archive', taskId })
      expect(archive.ok).toBe(true)
      expect(statusOf(engine, taskId)()).toBe('archived')
      // 归档后一切变更拒绝（只读）
      const edit = await engine.dispatch({ type: 'raiseMaxRounds', requestId: 'req-edit', taskId, maxRounds: 9 })
      expect(edit.ok).toBe(false)
    } finally {
      await cleanup(dir)
    }
  })

  it('ready 状态可编辑拆解结果（US-04），非法状态拒绝', async () => {
    const dir = await tempDir()
    try {
      const { engine } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const result = await engine.dispatch({
        type: 'createTask',
        requestId: 'req-edit',
        title: '可编辑任务',
        description: '描述',
        autoStart: false,
      })
      const taskId = result.taskId!
      await waitFor(() => statusOf(engine, taskId)() === 'ready')
      const sub0 = subtaskOf(engine, taskId, 0)
      const edit = await engine.dispatch({
        type: 'editSubtasks',
        requestId: 'req-edit-1',
        taskId,
        remove: [taskOf(engine, taskId).subtasks[1]!.id],
        update: [{ id: sub0.id, title: '改过的子任务' }],
        add: [{ title: '新增子任务', detail: 'd', acceptance: [{ text: '新验收' }], deps: [sub0.id] }],
      })
      expect(edit.ok).toBe(true)
      const task = taskOf(engine, taskId)
      expect(task.subtasks.map(s => s.title)).toEqual(['改过的子任务', '新增子任务'])
      expect(task.subtasks[1]!.deps).toEqual([sub0.id])
      expect(task.events.some(e => e.kind === 'subtasks-edited' && e.actor === 'human')).toBe(true)

      // 开工后编辑 → 拒绝
      await engine.dispatch({ type: 'startImplementation', requestId: 'req-start', taskId })
      const denied = await engine.dispatch({
        type: 'editSubtasks',
        requestId: 'req-edit-2',
        taskId,
        update: [{ id: sub0.id, title: 'x' }],
      })
      expect(denied.ok).toBe(false)
    } finally {
      await cleanup(dir)
    }
  })

  it('注入防护：批语与拆解说明均带来源声明包装（§7.3）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      await engine.dispatch({ type: 'rejectSubtask', requestId: 'req-r', taskId, comment: '请补充边界测试' })
      await waitFor(() => adapter.executionRuns.some(r => r.round >= 2))
      const secondRound = adapter.executionRuns.find(r => r.round >= 2)!
      expect(secondRound.prompt).toContain('人类验收批语')
      expect(secondRound.prompt).toContain('未经本会话审阅')
      // 拆解产物同样包装
      expect(adapter.decomposeRuns[0]!.prompt).toContain('未经本会话审阅')
    } finally {
      await cleanup(dir)
    }
  })

  it('调度遵守全局并发上限（M1 串行）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      let live = 0
      let peak = 0
      adapter.executionBehavior = async input => {
        live += 1
        peak = Math.max(peak, live)
        try {
          const result = await input.tools.submitEvidence(buildPassingEvidence(engine.getState().ledger, input.subtaskId))
          if (!result.accepted) throw new Error(result.correction)
        } finally {
          live -= 1
        }
      }
      const t1 = await createOneWordTask(engine)
      const t2 = await engine.dispatch({
        type: 'createTask',
        requestId: 'req-create-2',
        title: '第二个任务',
        description: '描述 2',
      })
      await waitFor(() => statusOf(engine, t1)() === 'review' && statusOf(engine, t2.taskId!)() === 'review')
      expect(peak).toBe(1)
    } finally {
      await cleanup(dir)
    }
  })

  it('重启恢复：无会话记录的运行取消并重新排队；有记录转接管（NFR-03）', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'ledger.json')
    try {
      let taskId: string
      {
        const { engine, adapter } = createEngine(file)
        await engine.boot()
        adapter.executionBehavior = async () => new Promise(() => {}) // 挂起的会话
        taskId = (await createOneWordTask(engine))!
        // 以「已落盘」为准（真实重启只能看到磁盘态；内存态与落盘之间存在窗口）
        await waitFor(() => {
          const persisted = JSON.parse(readFileSync(file, 'utf8')) as { tasks: Array<{ subtasks: Array<{ status: string; sessionId?: string }> }> }
          return persisted.tasks[0]!.subtasks.some(sub => sub.status === 'in-progress' && sub.sessionId !== undefined)
        })
      }
      // 模拟重启：新引擎、新 adapter（不知道旧会话 → 无记录）
      const { engine: engine2, adapter: adapter2 } = createEngine(file)
      await engine2.boot()
      const task = taskOf(engine2, taskId)
      expect(task.status).toBe('in-progress')
      // 无记录 → 取消本次运行并重新排队 → 调度器取号重跑（attempt 累计）
      await waitFor(() => taskOf(engine2, taskId).subtasks.some(s => s.history.some(e => e.kind === 'recovery')))
      await waitFor(() => statusOf(engine2, taskId)() === 'review')
      expect(adapter2.executionRuns.length).toBeGreaterThan(0)
      // ledger 持久化的事件含恢复留痕
      const raw = JSON.parse(await readFile(file, 'utf8')) as { tasks: Array<{ subtasks: Array<{ history: Array<{ kind?: string }> }> }> }
      expect(raw.tasks[0]!.subtasks.some(sub => sub.history.some(e => e.kind === 'recovery'))).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })

  it('重启恢复：有会话记录但无 adoptSession → 转 blocked 等人工', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'ledger.json')
    try {
      let taskId = ''
      let sessionId = ''
      {
        const { engine, adapter } = createEngine(file)
        await engine.boot()
        adapter.executionBehavior = async () => new Promise(() => {})
        taskId = (await createOneWordTask(engine))!
        await waitFor(() => {
          const persisted = JSON.parse(readFileSync(file, 'utf8')) as { tasks: Array<{ subtasks: Array<{ status: string; sessionId?: string }> }> }
          const sub = persisted.tasks[0]!.subtasks.find(x => x.status === 'in-progress' && x.sessionId !== undefined)
          if (sub) {
            sessionId = sub.sessionId!
            return true
          }
          return false
        })
      }
      const { engine: engine2, adapter: adapter2 } = createEngine(file)
      adapter2.knownSessions.add(sessionId) // 有记录
      await engine2.boot()
      await waitFor(() => taskOf(engine2, taskId).status === 'blocked')
      const sub = taskOf(engine2, taskId).subtasks[0]!
      expect(sub.status).toBe('blocked')
      expect(sub.history.some(e => e.kind === 'recovery' && (e.reason ?? '').includes('人工接管'))).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })

  it('持久化往返：JSON 可序列化、重启后事件完整（US-09 留痕）', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'ledger.json')
    try {
      const { engine } = createEngine(file)
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      await engine.dispatch({ type: 'approveTask', requestId: 'req-ok', taskId })
      const raw = JSON.parse(await readFile(file, 'utf8'))
      expect(raw.schemaVersion).toBe(1)
      expect(typeof raw.revision).toBe('number')
      const events = raw.tasks[0].events
      expect(events.length).toBeGreaterThan(4)
      expect(events[0].from).toBeNull()
      // 写回再读（防 JSON 细节如 undefined 字段破坏结构）
      await writeFile(file, JSON.stringify(raw), 'utf8')
      const { engine: engine2 } = createEngine(file)
      await engine2.boot()
      expect(statusOf(engine2, taskId)()).toBe('done')
    } finally {
      await cleanup(dir)
    }
  })
})
