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

/** 支持会话预设原地提升的 mock（断言 decideApproval「完全放行」的副作用）。 */
class ApprovableMockAdapter extends MockSessionAdapter {
  readonly elevateCalls: Array<{ sessionId: string; preset: string }> = []
  elevateSession: ((sessionId: string, preset: string) => Promise<boolean>) | undefined = (
    sessionId,
    preset,
  ) => {
    this.elevateCalls.push({ sessionId, preset })
    return Promise.resolve(true)
  }
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
      // 上限是可选防失控开关：显式设置 3，验证 T7′ 在其显式启用时仍然生效
      const created = await engine.dispatch({
        type: 'createTask',
        requestId: 'req-create-cap',
        title: '修复登录 500',
        description: '登录接口偶发 500，定位并修复，补回归测试。',
        maxRounds: 3,
      })
      expect(created.ok).toBe(true)
      const taskId = created.taskId!
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      expect(taskOf(engine, taskId).round).toBe(1)

      // 打回：默认路径 = AI triage 定位返工范围（mock 默认全量），返回值为空数组、范围异步应用
      const reject = await engine.dispatch({
        type: 'rejectSubtask',
        requestId: 'req-reject-1',
        taskId,
        comment: '测试没有覆盖并发场景，请补并发回归后再提交。',
      })
      expect(reject.ok).toBe(true)
      expect(adapter.triageRuns.length).toBe(1)
      expect(adapter.triageRuns[0]!.prompt).toContain('测试没有覆盖并发场景')
      await waitFor(() => taskOf(engine, taskId).round === 2)

      // 下一轮执行注入批语原文（§4.7）
      await waitFor(() => adapter.executionRuns.some(r => r.prompt.includes('测试没有覆盖并发场景')))
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      // 第二轮的证据里 round 记录为 2
      expect(subtaskOf(engine, taskId, 0).round).toBe(2)
      expect(subtaskOf(engine, taskId, 0).evidenceHistory).toHaveLength(2)

      // 打回至迭代上限（显式 maxRounds=3，当前 round=2 → 打回后 round=3 允许；再一次触发 T7′）
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
        pins: { permission: 'workspace-write', executionMode: 'approval' },
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

describe('执行审批流（§7.1b：approval 模式 + decideApproval 两档裁决）', () => {
  /** 组装 approval 模式引擎：每个执行会话先发起一次提权审批，按裁决结果分流。 */
  function createApprovalEngine(
    file: string,
    elevate: 'ok' | 'fail' | 'none' = 'ok',
  ): { engine: TaskflowEngine; adapter: ApprovableMockAdapter } {
    const box: { engine?: TaskflowEngine } = {}
    const adapter = new ApprovableMockAdapter({ getLedger: () => box.engine!.getState().ledger })
    if (elevate === 'fail') {
      adapter.elevateSession = () => Promise.resolve(false)
    } else if (elevate === 'none') {
      adapter.elevateSession = undefined
    }
    const asked = new Set<string>()
    adapter.executionBehavior = async input => {
      // 每任务首个执行会话发起一次提权审批（后续子任务直接执行，便于断言收束）
      if (!asked.has(input.taskId)) {
        asked.add(input.taskId)
        const decision = await input.approvals.request({
          sessionId: input.sessionId,
          toolName: 'write',
          reason: '需要写入产物文件',
        })
        if (decision === 'rejected') {
          await input.tools.reportBlocker('提权被拒：无法写文件，中止执行')
          return
        }
      }
      const result = await input.tools.submitEvidence(buildPassingEvidence(box.engine!.getState().ledger, input.subtaskId))
      if (!result.accepted) throw new Error(`mock evidence rejected: ${result.correction}`)
    }
    const engine = new TaskflowEngine(new LedgerStore(file), adapter, DEFAULT_ENGINE_CONFIG)
    box.engine = engine
    return { engine, adapter }
  }

  async function createApprovalTask(engine: TaskflowEngine, requestId: string): Promise<string> {
    const created = await engine.dispatch({
      type: 'createTask',
      requestId,
      title: '整理项目文档',
      description: '整理文档结构并输出 markdown 报告。',
      pins: { executionMode: 'approval' },
    })
    expect(created.ok).toBe(true)
    return created.taskId!
  }

  it('完全放行：审批落库 pending → allow → elevateSession → 证据受理进验收', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createApprovalEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const taskId = await createApprovalTask(engine, 'appr-create-1')

      // 会话带着 approval 模式与审批桥启动，第一笔写操作 → 审批 pending
      await waitFor(() => taskOf(engine, taskId).approvals?.some(a => a.status === 'pending') ?? false)
      const record = taskOf(engine, taskId).approvals![0]!
      expect(record.toolName).toBe('write')
      expect(record.sessionId).toBe(subtaskOf(engine, taskId, 0).sessionId)
      expect(adapter.executionRuns[0]?.executionMode).toBe('approval')
      expect(subtaskOf(engine, taskId, 0).history.some(e => e.kind === 'approval-requested')).toBe(true)
      // 等审批期间子任务保持执行中（会话挂起，不算崩溃）
      expect(subtaskOf(engine, taskId, 0).status).toBe('in-progress')

      // 人工「完全放行」→ elevateSession(sessionId, workspace-write) → 会话继续 → 证据受理
      const decided = await engine.dispatch({
        type: 'decideApproval',
        requestId: 'appr-allow-1',
        taskId,
        approvalId: record.id,
        decision: 'allow',
      })
      expect(decided.ok).toBe(true)
      expect(adapter.elevateCalls).toEqual([{ sessionId: record.sessionId, preset: 'workspace-write' }])
      await waitFor(() => taskOf(engine, taskId).status === 'review')
      expect(taskOf(engine, taskId).approvals![0]!.status).toBe('elevated')
      expect(subtaskOf(engine, taskId, 0).history.some(e => e.kind === 'approval-elevated')).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })

  it('拒绝：reject → 模型收到拒绝并可报障 → 子任务/任务 blocked', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createApprovalEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const taskId = await createApprovalTask(engine, 'appr-create-2')
      await waitFor(() => taskOf(engine, taskId).approvals?.some(a => a.status === 'pending') ?? false)
      const record = taskOf(engine, taskId).approvals![0]!

      const decided = await engine.dispatch({
        type: 'decideApproval',
        requestId: 'appr-reject-1',
        taskId,
        approvalId: record.id,
        decision: 'reject',
        note: '只允许读操作',
      })
      expect(decided.ok).toBe(true)
      expect(adapter.elevateCalls).toHaveLength(0)
      await waitFor(() => taskOf(engine, taskId).status === 'blocked')
      expect(taskOf(engine, taskId).approvals![0]!.status).toBe('rejected')
      const sub = subtaskOf(engine, taskId, 0)
      expect(sub.status).toBe('blocked')
      expect(sub.history.some(e => e.kind === 'approval-rejected')).toBe(true)
      expect(sub.history.some(e => e.kind === 'blocker-reported')).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })

  it('裁决守卫：未知审批 404、重复裁决拒绝、elevate 失败闭环为 expired', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createApprovalEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const taskId = await createApprovalTask(engine, 'appr-create-3')
      await waitFor(() => taskOf(engine, taskId).approvals?.some(a => a.status === 'pending') ?? false)
      const record = taskOf(engine, taskId).approvals![0]!

      const missing = await engine.dispatch({
        type: 'decideApproval', requestId: 'g1', taskId, approvalId: 'ap_missing', decision: 'allow',
      })
      expect(missing.ok).toBe(false)
      expect(missing.code).toBe('not-found')

      const first = await engine.dispatch({ type: 'decideApproval', requestId: 'g2', taskId, approvalId: record.id, decision: 'allow' })
      expect(first.ok).toBe(true)
      const second = await engine.dispatch({ type: 'decideApproval', requestId: 'g3', taskId, approvalId: record.id, decision: 'allow' })
      expect(second.ok).toBe(false)
      expect(second.code).toBe('guard')
      await waitFor(() => taskOf(engine, taskId).status === 'review')
      void adapter
    } finally {
      await cleanup(dir)
    }

    // elevate 失败：审批闭环为 expired，错误回给 UI（会话若仍在会重新发起）
    const dir2 = await tempDir()
    try {
      const { engine } = createApprovalEngine(path.join(dir2, 'ledger.json'), 'fail')
      await engine.boot()
      const taskId = await createApprovalTask(engine, 'appr-create-4')
      await waitFor(() => taskOf(engine, taskId).approvals?.some(a => a.status === 'pending') ?? false)
      const record = taskOf(engine, taskId).approvals![0]!
      const failed = await engine.dispatch({ type: 'decideApproval', requestId: 'g4', taskId, approvalId: record.id, decision: 'allow' })
      expect(failed.ok).toBe(false)
      expect(taskOf(engine, taskId).approvals![0]!.status).toBe('expired')
    } finally {
      await cleanup(dir2)
    }
  })

  it('updateContract：blocked 态仅允许修 pins（权限签错可救）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'), { decomposeRetries: 0 })
      adapter.decomposeBehavior = () => ({ kind: 'failed', error: 'mock 拆解失败' })
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'blocked')

      const editObjective = await engine.dispatch({ type: 'updateContract', requestId: 'uc-1', taskId, objective: '新目标' })
      expect(editObjective.ok).toBe(false)
      const editAcceptance = await engine.dispatch({ type: 'updateContract', requestId: 'uc-2', taskId, acceptance: [{ text: '新验收' }] })
      expect(editAcceptance.ok).toBe(false)
      const editPins = await engine.dispatch({ type: 'updateContract', requestId: 'uc-3', taskId, pins: { permission: 'workspace-write', executionMode: 'approval' } })
      expect(editPins.ok).toBe(true)
      const task = taskOf(engine, taskId)
      expect(task.contract.pins.permission).toBe('workspace-write')
      expect(task.contract.pins.executionMode).toBe('approval')
      expect(task.permissionConfirmed).toBe(false) // §7.1 re-arm（approval 档 + 越权 → 重新需要确认；auto 档则免确认）
    } finally {
      await cleanup(dir)
    }
  })
})

describe('调度健康与权限门（2026-09-10 真机事故回归）', () => {
  it('终态任务孤儿会话：boot 收敛，且不阻塞新任务调度（WIP 死锁回归）', async () => {
    const dir = await tempDir()
    try {
      // 一阶段：正常跑一个任务并取消，然后把子任务手工回退成「旧版取消遗留」的孤儿形态
      // （终态任务上挂着 in-progress + sessionId）——正是真机事故时的 ledger 状态。
      const first = createEngine(path.join(dir, 'ledger.json'))
      await first.engine.boot()
      const taskA = await createOneWordTask(first.engine)
      await waitFor(() => first.adapter.executionRuns.length >= 1)
      await first.engine.dispatch({ type: 'cancelTask', requestId: 'req-cancel', taskId: taskA, confirm: true })
      const ledgerPath = path.join(dir, 'ledger.json')
      const raw = JSON.parse(await readFile(ledgerPath, 'utf8'))
      for (const sub of raw.tasks[0].subtasks) {
        sub.status = 'in-progress'
        sub.sessionId = 'tfs_legacy_orphan_r1a99_x'
      }
      await writeFile(ledgerPath, JSON.stringify(raw))

      // 二阶段：新引擎 boot —— 孤儿应被收敛，且新任务在 maxConcurrentSubtasks=1 下照常调度
      const box: { engine?: TaskflowEngine } = {}
      const adapter = new MockSessionAdapter({ getLedger: () => box.engine!.getState().ledger })
      const engine = new TaskflowEngine(new LedgerStore(ledgerPath), adapter, DEFAULT_ENGINE_CONFIG)
      box.engine = engine
      await engine.boot()
      const orphan = taskOf(engine, taskA).subtasks[0]!
      expect(orphan.status).toBe('blocked') // boot 收敛
      expect(orphan.sessionId).toBeUndefined()
      expect(orphan.history.at(-1)?.reason).toContain('清理残留运行标记')
      expect(taskOf(engine, taskA).status).toBe('cancelled') // 终态不被改写

      const taskB = await createOneWordTask(engine)
      // mock 默认行为秒交证据：子任务可能已越过 in-progress；以 sessionId 落号作为调度信号
      await waitFor(() => taskOf(engine, taskB).subtasks.some(s => s.sessionId !== undefined))
      await waitFor(() => statusOf(engine, taskB)() !== 'draft' && statusOf(engine, taskB)() !== 'decomposing')
      const subB = taskOf(engine, taskB).subtasks.find(s => s.sessionId !== undefined)
      expect(subB?.sessionId).toBeTruthy()
    } finally {
      await cleanup(dir)
    }
  })

  it('取消任务收敛运行中子任务：终态不残留 in-progress + sessionId（T9）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      adapter.executionBehavior = async () => new Promise(() => {})
      const taskId = await createOneWordTask(engine)
      await waitFor(() => taskOf(engine, taskId).subtasks.some(s => s.status === 'in-progress' && s.sessionId !== undefined))
      const cancel = await engine.dispatch({ type: 'cancelTask', requestId: 'req-cancel', taskId, confirm: true })
      expect(cancel.ok).toBe(true)
      const task = taskOf(engine, taskId)
      expect(task.status).toBe('cancelled')
      expect(task.subtasks.every(s => s.status !== 'in-progress' || s.sessionId === undefined)).toBe(true)
      expect(task.subtasks.some(s => s.status === 'blocked')).toBe(true) // 收敛留痕
    } finally {
      await cleanup(dir)
    }
  })

  it('完全权限（auto）创建即免确认门；approval 档 + 越权仍须确认；默认迭代上限不限', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()

      // auto 档：workspace-write + auto → 创建即确认，自动开工一路跑到 review，无确认事件
      const auto = await engine.dispatch({
        type: 'createTask',
        requestId: 'req-auto',
        title: '完全权限任务',
        description: '全自动跑完',
        pins: { permission: 'workspace-write', executionMode: 'auto' },
      })
      expect(auto.ok).toBe(true)
      const autoId = auto.taskId!
      expect(taskOf(engine, autoId).maxRounds).toBeNull() // 默认不限：任务一直跑到人工验收为止
      await waitFor(() => {
        const t = taskOf(engine, autoId)
        return t.status === 'review'
      })
      expect(taskOf(engine, autoId).subtasks.every(s => s.status === 'review')).toBe(true)

      // approval 档 + workspace-write：确认门前置，拆解后排队等人，不发会话
      const appr = await engine.dispatch({
        type: 'createTask',
        requestId: 'req-appr',
        title: '审批模式任务',
        description: '写操作要逐次问我',
        pins: { permission: 'workspace-write', executionMode: 'approval' },
      })
      expect(appr.ok).toBe(true)
      const apprId = appr.taskId!
      await waitFor(() => statusOf(engine, apprId)() === 'in-progress')

      // 人工确认后放行
      const confirm = await engine.dispatch({ type: 'startImplementation', requestId: 'req-confirm', taskId: apprId, confirmPermission: true })
      expect(confirm.ok).toBe(true)
      let __probeN = 0
      await waitFor(() => { const t = taskOf(engine, apprId); __probeN += 1; if (__probeN % 100 === 0) console.log('[P]', t.status, t.subtasks.map(s => `${s.status}:${s.sessionId ? 'sid' : '-'}`).join(','), 'pc', t.permissionConfirmed, 'live', [...(engine as unknown as { liveExecutionSessions: Set<string> }).liveExecutionSessions].map(s => s.slice(8, 30)), 'auto', statusOf(engine, autoId)()); return t.subtasks.some(s => s.status === 'in-progress' && s.sessionId !== undefined) })
    } finally {
      await cleanup(dir)
    }
  })
})

describe('执行会话看门狗（G2：无声挂起可见化）', () => {
  // 注意：ledger 落盘是真实 fs，与假计时器互相饿死；用真实计时器 + 0.05 分钟（3s）短超时
  it('无审批静默超时 → blocked（T8）+ 取消会话；等审批则顺延不误杀', async () => {
    const dir = await tempDir()
    try {
      const box: { engine?: TaskflowEngine } = {}
      const adapter = new MockSessionAdapter({ getLedger: () => box.engine!.getState().ledger })
      const asked = new Set<string>()
      adapter.executionBehavior = async input => {
        if (input.executionMode === 'approval') {
          // 审批模式：每任务首个会话发起审批（等人不算停滞）；裁决后提交证据
          if (!asked.has(input.taskId)) {
            asked.add(input.taskId)
            await input.approvals.request({ sessionId: input.sessionId, toolName: 'write', reason: '写文件' })
          }
          const result = await input.tools.submitEvidence(buildPassingEvidence(box.engine!.getState().ledger, input.subtaskId))
          if (!result.accepted) throw new Error(`mock evidence rejected: ${result.correction}`)
          return
        }
        await new Promise(() => {}) // auto 模式任务：无声挂起（故障注入）
      }
      const engine = new TaskflowEngine(new LedgerStore(path.join(dir, 'ledger.json')), adapter, {
        ...DEFAULT_ENGINE_CONFIG,
        sessionStallTimeoutMin: 0.05, // 3 秒
      })
      box.engine = engine
      await engine.boot()

      // 任务 A（显式 auto 模式）：静默超过 3 秒 → 看门狗转 blocked + 取消会话
      // （无 pins 的旧任务按兼容推导是 approval 模式——会转审批而非静默挂起，正是设计意图）
      const taskA = await engine.dispatch({
        type: 'createTask', requestId: 'wd-a', title: 'A 无声挂起', description: 'd',
        pins: { executionMode: 'auto' },
      })
      expect(taskA.ok).toBe(true)
      await waitFor(() => subtaskOf(engine, taskA.taskId!, 0).status === 'in-progress')
      await waitFor(() => subtaskOf(engine, taskA.taskId!, 0).status === 'blocked', { timeout: 15_000 })
      expect(taskOf(engine, taskA.taskId!).status).toBe('blocked')
      expect(subtaskOf(engine, taskA.taskId!, 0).history.some(e => e.kind === 'session-stalled')).toBe(true)
      await waitFor(() => adapter.cancelled.length > 0)
      expect(adapter.cancelled).toContain(subtaskOf(engine, taskA.taskId!, 0).sessionId)

      // 任务 B（approval 模式）：审批 pending 远超看门狗周期也不误杀；放行后正常完成
      const taskB = await engine.dispatch({
        type: 'createTask', requestId: 'wd-b', title: 'B 等审批', description: 'd',
        pins: { executionMode: 'approval' },
      })
      expect(taskB.ok).toBe(true)
      const taskIdB = taskB.taskId!
      await waitFor(() => taskOf(engine, taskIdB).approvals?.some(a => a.status === 'pending') ?? false)
      await new Promise(resolve => setTimeout(resolve, 4_000)) // 跨过 2 个看门狗周期
      expect(subtaskOf(engine, taskIdB, 0).status).toBe('in-progress')
      const record = taskOf(engine, taskIdB).approvals![0]!
      const decided = await engine.dispatch({
        type: 'decideApproval', requestId: 'wd-b-allow', taskId: taskIdB, approvalId: record.id, decision: 'allow',
      })
      expect(decided.ok).toBe(true)
      await waitFor(() => taskOf(engine, taskIdB).status === 'review')
    } finally {
      await cleanup(dir)
    }
  }, 25_000)

  it('sessionStallTimeoutMin = 0 关闭看门狗', async () => {
    const dir = await tempDir()
    try {
      const box: { engine?: TaskflowEngine } = {}
      const adapter = new MockSessionAdapter({ getLedger: () => box.engine!.getState().ledger })
      adapter.executionBehavior = async () => {
        await new Promise(() => {})
      }
      const engine = new TaskflowEngine(new LedgerStore(path.join(dir, 'ledger.json')), adapter, {
        ...DEFAULT_ENGINE_CONFIG,
        sessionStallTimeoutMin: 0,
      })
      box.engine = engine
      await engine.boot()
      const created = await engine.dispatch({ type: 'createTask', requestId: 'wd-off', title: '关闭看门狗', description: 'd' })
      expect(created.ok).toBe(true)
      await waitFor(() => subtaskOf(engine, created.taskId!, 0).status === 'in-progress')
      await new Promise(resolve => setTimeout(resolve, 3_500))
      expect(subtaskOf(engine, created.taskId!, 0).status).toBe('in-progress')
    } finally {
      await cleanup(dir)
    }
  })
})

describe('全局模型设置（§PLAN-MODEL：两槽传递 + 留痕）', () => {
  it('默认两槽 model = null（跟随宿主默认），事件 refs 不带 model', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')

      expect(engine.getModelSettings()).toEqual({ decompose: null, execution: null })
      expect(adapter.decomposeRuns[0]?.model).toBeNull()
      for (const run of adapter.executionRuns) expect(run.model).toBeNull()
      const task = taskOf(engine, taskId)
      expect(task.events.some(event => event.refs?.model !== undefined)).toBe(false)
      for (const sub of task.subtasks) {
        expect(sub.history.some(event => event.refs?.model !== undefined)).toBe(false)
      }
    } finally {
      await cleanup(dir)
    }
  })

  it('设置后：拆解/执行输入携带对应槽位模型，事件 refs.model 留痕', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      engine.setModelSettings({
        decompose: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
        execution: { provider: 'ollama', model: 'qwen3:8b' },
      })
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')

      expect(adapter.decomposeRuns[0]?.model).toEqual({
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        reasoningEffort: 'high',
      })
      for (const run of adapter.executionRuns) {
        expect(run.model).toEqual({ provider: 'ollama', model: 'qwen3:8b' })
      }
      const task = taskOf(engine, taskId)
      expect(task.events.find(event => event.refs?.model !== undefined)?.refs?.model).toBe('deepseek/deepseek-reasoner·high')
      const withModel = task.subtasks.flatMap(sub => sub.history).find(event => event.refs?.model !== undefined)
      expect(withModel?.refs?.model).toBe('ollama/qwen3:8b')
      // 快照隔离：改设置不影响已创建对象的引用
      engine.setModelSettings({ decompose: null, execution: null })
      expect(task.events.some(event => event.refs?.model !== undefined)).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })
})

// —— 2026-09-11 语义升级：任务级终检 + 打回定位（§4.5/§4.6） ——

describe('任务级终检与打回定位（2026-09-11 语义）', () => {
  it('终检：全部子任务齐备 → AI 终检产出任务级证据 → 才进 review（T5 延后）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const taskId = await createOneWordTask(engine)

      // 中间态：子任务证据齐全 → 终检被自动调度（fire-and-forget，等它被调用）
      await waitFor(() => taskOf(engine, taskId).subtasks.every(s => s.evidence !== undefined))
      await waitFor(() => adapter.finalizeRuns.length >= 1)
      expect(adapter.finalizeRuns.length).toBeGreaterThanOrEqual(1)
      const finalPrompt = adapter.finalizeRuns[0]!.prompt
      expect(finalPrompt).toContain('任务级终检合同')
      expect(finalPrompt).toContain('逐条核验')

      await waitFor(() => statusOf(engine, taskId)() === 'review')
      const task = taskOf(engine, taskId)
      expect(task.evidence).toBeDefined()
      expect(task.evidence!.selfCheck).toHaveLength(task.contract.acceptance.length)
      expect(task.evidence!.selfCheck.every(c => c.verdict === 'pass')).toBe(true)
      expect(task.finalizeSessionId).toBeUndefined()
      expect(task.events.find(e => e.kind === 'final-check-started')).toBeDefined()
      expect(task.events.find(e => e.kind === 'task-evidence-submitted')).toBeDefined()
      expect(task.events.some(e => e.to === 'review' && (e.reason ?? '').includes('终检完成'))).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })

  it('终检失败：自动重试 1 次 → 仍失败 → 无任务级证据进 review（T5 兜底）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      adapter.finalizeBehavior = async () => ({ kind: 'failed', error: 'mock 终检崩溃' })
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')

      expect(adapter.finalizeRuns.length).toBe(2) // 首跑 + 1 次重试
      const task = taskOf(engine, taskId)
      expect(task.evidence).toBeUndefined()
      expect(task.finalizeSessionId).toBeUndefined()
      expect(task.events.some(e => e.kind === 'final-check-fallback')).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })

  it('终检产物缺自检条目 → 拒收视为失败走兜底；generateTaskEvidence 可人工补跑', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      adapter.finalizeBehavior = async input => ({
        kind: 'ok',
        output: {
          changesSummary: '终检摘要',
          verification: [{ label: 'check', output: 'ok', passed: true }],
          selfCheck: [], // 缺条：与任务级验收标准不等长 → 拒收
          ...(input.taskId.includes('_') ? {} : {}),
        },
      })
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      expect(taskOf(engine, taskId).evidence).toBeUndefined()

      // 人工补跑：换回成功行为 → 任务级证据出现，任务停在 review
      adapter.finalizeBehavior = undefined
      const rerun = await engine.dispatch({ type: 'generateTaskEvidence', requestId: 'req-gen-ev', taskId })
      expect(rerun.ok, JSON.stringify(rerun)).toBe(true)
      await waitFor(() => taskOf(engine, taskId).evidence !== undefined)
      expect(statusOf(engine, taskId)()).toBe('review')
      expect(adapter.finalizeRuns.length).toBe(3)
    } finally {
      await cleanup(dir)
    }
  })

  it('打回定位：AI 把批语映射到子集 → 仅该子任务返工，其余保持 review 不重跑', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      const before = taskOf(engine, taskId)
      const s2EvidenceBefore = before.subtasks[1]!.evidence
      const execCountBefore = adapter.executionRuns.length

      adapter.triageBehavior = async input => ({
        kind: 'ok',
        output: { reworkSubtaskIds: [`${input.taskId}_s1`], note: '批语只涉及第一个子任务' },
      })
      const rejected = await engine.dispatch({
        type: 'rejectSubtask',
        requestId: 'req-reject-triage',
        taskId,
        comment: '核心逻辑的边界场景没覆盖',
      })
      expect(rejected.ok).toBe(true)
      await waitFor(() => taskOf(engine, taskId).round === 2)

      const task = taskOf(engine, taskId)
      expect(task.status).toBe('in-progress')
      expect(task.subtasks[0]!.status).toBe('in-progress')
      expect(task.subtasks[0]!.round).toBe(2)
      expect(task.subtasks[1]!.status).toBe('review') // 未被点名：不返工
      expect(task.subtasks[1]!.evidence).toEqual(s2EvidenceBefore)
      expect(task.evidence).toBeUndefined() // 任务级证据随返工作废
      expect(task.events.some(e => e.kind === 'rework-scope' && (e.reason ?? '').includes('批语只涉及第一个子任务'))).toBe(true)
      // 批语只注入被点名的子任务；s2 不产生新的执行会话
      await waitFor(() => adapter.executionRuns.length === execCountBefore + 1)
      expect(adapter.executionRuns.at(-1)!.prompt).toContain('核心逻辑的边界场景没覆盖')
      expect(adapter.executionRuns.at(-1)!.subtaskId).toBe(`${taskId}_s1`)
    } finally {
      await cleanup(dir)
    }
  })

  it('打回定位失败 → 全量兜底（回退旧语义）', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      adapter.triageBehavior = async () => ({ kind: 'failed', error: 'mock 定位崩溃' })

      const rejected = await engine.dispatch({
        type: 'rejectSubtask',
        requestId: 'req-reject-fallback',
        taskId,
        comment: '整体返工',
      })
      expect(rejected.ok).toBe(true)
      await waitFor(() => taskOf(engine, taskId).round === 2)
      const task = taskOf(engine, taskId)
      expect(task.subtasks.every(s => s.status === 'in-progress')).toBe(true)
      expect(task.events.some(e => e.kind === 'rework-scope' && (e.reason ?? '').includes('全量兜底'))).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })
})

describe('交付物一等公民（§4.5b：artifacts 声明 + 只读预览）', () => {
  it('终检产出 artifacts → 落库 task.evidence.artifacts；事件留痕交付物数', async () => {
    const dir = await tempDir()
    try {
      const reportPath = path.join(dir, '整理报告.md')
      await writeFile(reportPath, '# 报告\n\n正文', 'utf8')
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      // 创建任务前就布置终检行为：acceptance id 运行时动态查（终检只在全部子任务举证后触发，无竞态）
      adapter.finalizeBehavior = async input => {
        const task = engine.getState().ledger.tasks.find(t => t.id === input.taskId)
        const acceptance = task?.contract.acceptance ?? []
        return {
          kind: 'ok',
          output: {
            changesSummary: '整体交付完成，报告已落盘',
            verification: [{ label: 'ls -l 报告', output: 'exists', passed: true }],
            selfCheck: acceptance.map(a => ({ acceptanceId: a.id, verdict: 'pass' as const, note: '逐条核验通过' })),
            artifacts: [{ path: reportPath, description: '整理报告 Markdown', howVerified: 'ls -l + 章节完整性' }],
          },
        }
      }
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => statusOf(engine, taskId)() === 'review')
      const task = taskOf(engine, taskId)
      expect(task.evidence!.artifacts).toEqual([
        { path: reportPath, description: '整理报告 Markdown', howVerified: 'ls -l + 章节完整性' },
      ])
      expect(task.events.some(e => (e.reason ?? '').includes('交付物 1 项'))).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })

  it('子任务证据可带 artifacts；readArtifactPreview 只放行声明过的路径', async () => {
    const dir = await tempDir()
    try {
      const declared = path.join(dir, 'declared.txt')
      const secret = path.join(dir, 'secret.txt')
      await writeFile(declared, '# 只有声明过的文件可读', 'utf8')
      await writeFile(secret, 'not allowed', 'utf8')
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      adapter.executionBehavior = async input => {
        const ledger = engine.getState().ledger
        const sub = ledger.tasks.flatMap(t => t.subtasks).find(s => s.id === input.subtaskId)
        if (sub === undefined) throw new Error('subtask missing')
        const result = await input.tools.submitEvidence({
          changesSummary: `（测试）完成 ${sub.title}`,
          verification: [{ label: 'check', output: 'ok', passed: true }],
          selfCheck: sub.acceptance.map(a => ({ acceptanceId: a.id, verdict: 'pass' as const, note: '' })),
          ...(sub.id.endsWith('_s1') ? { artifacts: [{ path: declared, description: '声明产物' }] } : {}),
        })
        if (!result.accepted) throw new Error(result.correction)
      }
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => taskOf(engine, taskId).subtasks.every(s => s.evidence !== undefined))
      const s1 = taskOf(engine, taskId).subtasks[0]!
      expect(s1.evidence!.artifacts).toEqual([{ path: declared, description: '声明产物' }])

      // 声明过的路径可预览；未声明的同目录文件被拒绝（白名单语义）
      const ok = await engine.readArtifactPreview(taskId, declared)
      expect(ok.binary).toBe(false)
      expect(ok.content).toContain('只有声明过的文件可读')
      expect(ok.truncated).toBe(false)
      await expect(engine.readArtifactPreview(taskId, secret)).rejects.toMatchObject({ code: 'not-declared' })
      await expect(engine.readArtifactPreview(taskId, 'relative.txt')).rejects.toMatchObject({ code: 'invalid-path' })
      await expect(engine.readArtifactPreview('tf_missing', declared)).rejects.toMatchObject({ code: 'not-found' })
    } finally {
      await cleanup(dir)
    }
  })

  it('预览守卫：>256KiB 截断、二进制拒显、目录拒显、文件缺失可辨', async () => {
    const dir = await tempDir()
    try {
      const bigPath = path.join(dir, 'big.txt')
      const binPath = path.join(dir, 'blob.bin')
      const dirPath = path.join(dir, 'adir')
      const gonePath = path.join(dir, 'gone.txt')
      const { writeFile: wf, mkdir: md } = await import('node:fs/promises')
      await wf(bigPath, 'x'.repeat(300 * 1024), 'utf8')
      await wf(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]))
      await md(dirPath, { recursive: true })
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      adapter.executionBehavior = async input => {
        const ledger = engine.getState().ledger
        const sub = ledger.tasks.flatMap(t => t.subtasks).find(s => s.id === input.subtaskId)
        if (sub === undefined) throw new Error('subtask missing')
        const result = await input.tools.submitEvidence({
          changesSummary: `（测试）完成 ${sub.title}`,
          verification: [{ label: 'check', output: 'ok', passed: true }],
          selfCheck: sub.acceptance.map(a => ({ acceptanceId: a.id, verdict: 'pass' as const, note: '' })),
          artifacts: [bigPath, binPath, dirPath, gonePath].map(p => ({ path: p })),
        })
        if (!result.accepted) throw new Error(result.correction)
      }
      await engine.boot()
      const taskId = await createOneWordTask(engine)
      await waitFor(() => taskOf(engine, taskId).subtasks.every(s => s.evidence !== undefined))

      const big = await engine.readArtifactPreview(taskId, bigPath)
      expect(big.truncated).toBe(true)
      expect(big.content.length).toBeLessThanOrEqual(256 * 1024)

      const bin = await engine.readArtifactPreview(taskId, binPath)
      expect(bin.binary).toBe(true)
      expect(bin.content).toBe('')

      await expect(engine.readArtifactPreview(taskId, dirPath)).rejects.toMatchObject({ code: 'not-a-file' })
      await expect(engine.readArtifactPreview(taskId, gonePath)).rejects.toMatchObject({ code: 'not-found' })
    } finally {
      await cleanup(dir)
    }
  })
})
