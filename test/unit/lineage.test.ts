/**
 * 任务接续 / 血缘 DAG 宿主测试（PLAN-FOLLOWUP）。
 *
 * 覆盖：接续建卡（parentIds/depth 落库 + handoff 事件 + 拆解提示注入交接摘要）、
 * 血缘守卫（父必须 done / 存在 / 去重 / 数量上限）、pins 继承（第一父为准 + 显式覆盖）、
 * 分叉与合流拓扑、交接摘要逐父独立。
 *
 * @module dsh-taskflow/test
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_CONFIG, TaskflowEngine } from '../../src/host/engine.ts'
import type { DispatchResult } from '../../src/host/engine.ts'
import { LedgerStore } from '../../src/host/ledger.ts'
import { MockSessionAdapter } from '../../src/host/mock/session-adapter.ts'
import { cleanup, ledgerOf, taskOf, tempDir, waitFor } from '../helpers.ts'
import { renderHandoffDigest } from '../../src/host/prompts.ts'

function createEngine(file: string): { engine: TaskflowEngine; adapter: MockSessionAdapter } {
  const box: { engine?: TaskflowEngine } = {}
  const adapter = new MockSessionAdapter({ getLedger: () => box.engine!.getState().ledger })
  const engine = new TaskflowEngine(new LedgerStore(file), adapter, { ...DEFAULT_ENGINE_CONFIG })
  box.engine = engine
  return { engine, adapter }
}

function statusOf(engine: TaskflowEngine, taskId: string): () => string {
  return () => ledgerOf(engine).tasks.find(t => t.id === taskId)?.status ?? 'missing'
}

/** 走完整主链路造一个 done 任务（自动拆解 → 自动开工 → mock 证据 → 人工终批）。 */
async function createDoneTask(engine: TaskflowEngine, title: string, requestId: string, workspace?: string): Promise<string> {
  const result: DispatchResult = await engine.dispatch({
    type: 'createTask',
    requestId,
    title,
    description: `${title} 的描述。`,
    acceptance: [{ text: `${title} 的验收标准。` }],
    ...(workspace !== undefined ? { pins: { workspace } } : {}),
  })
  expect(result.ok).toBe(true)
  const taskId = result.taskId!
  await waitFor(() => statusOf(engine, taskId)() === 'review')
  const approve = await engine.dispatch({ type: 'approveTask', requestId: `${requestId}:approve`, taskId })
  expect(approve.ok).toBe(true)
  expect(statusOf(engine, taskId)()).toBe('done')
  return taskId
}

describe('血缘：接续建卡', () => {
  it('basedOn 指向 done 父任务：落库 parentIds/depth + handoff 事件 + 拆解提示注入交接摘要 + 自动拆解', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const parentId = await createDoneTask(engine, '实现会话持久化', 'req-p1')

      const result = await engine.dispatch({
        type: 'createTask',
        requestId: 'req-child',
        title: '续做：性能优化',
        description: '接续上一棒继续做。',
        basedOn: [parentId],
      })
      expect(result.ok).toBe(true)
      const child = taskOf(engine, result.taskId!)
      expect(child.parentIds).toEqual([parentId])
      expect(child.depth).toBe(1)
      // 接续即拆解（autoDecompose 默认 true，未因 basedOn 改变语义）
      expect(child.status === 'decomposing' || child.status !== 'draft').toBe(true)
      await waitFor(() => statusOf(engine, result.taskId!)() === 'ready' || statusOf(engine, result.taskId!)() === 'in-progress')
      // handoff 事件留痕
      const handoff = child.events.find(e => e.kind === 'handoff')
      expect(handoff).toBeDefined()
      expect(handoff?.reason).toContain('实现会话持久化')
      // 创建事件标注接续来源
      expect(child.events[0]?.reason).toContain('接续自')
      // 拆解提示注入交接摘要（带来源声明包装）
      const decomposeInput = adapter.decomposeRuns.find(r => r.taskId === child.id)
      expect(decomposeInput).toBeDefined()
      expect(decomposeInput!.prompt).toContain('接续任务')
      expect(decomposeInput!.prompt).toContain('实现会话持久化')
      expect(decomposeInput!.prompt).toContain('上一棒任务交接摘要')
    } finally {
      await cleanup(dir)
    }
  })

  it('血缘守卫：父不存在 / 非 done / 重复 / 超上限，分别报 guard/format', async () => {
    const dir = await tempDir()
    try {
      const { engine } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      // 父不存在
      const missing = await engine.dispatch({
        type: 'createTask', requestId: 'g1', title: 'T', description: 'd',
        basedOn: ['tf_nonexistent'],
      })
      expect(missing.ok).toBe(false)
      expect(missing.code).toBe('guard')
      // 非 done（draft 不可作父）
      const draft = await engine.dispatch({ type: 'createTask', requestId: 'g2-p', title: 'P', description: 'd', autoDecompose: false })
      const notDone = await engine.dispatch({
        type: 'createTask', requestId: 'g2', title: 'T', description: 'd',
        basedOn: [draft.taskId!],
      })
      expect(notDone.ok).toBe(false)
      expect(notDone.code).toBe('guard')
      expect(notDone.error).toContain('尚未完成')
      // 重复（协议层 format 校验）
      const dup = await engine.dispatch({
        type: 'createTask', requestId: 'g3', title: 'T', description: 'd',
        basedOn: ['tf_a', 'tf_a'],
      })
      expect(dup.ok).toBe(false)
      expect(dup.code).toBe('format')
      // 超上限（协议层 format 校验）
      const overflow = await engine.dispatch({
        type: 'createTask', requestId: 'g4', title: 'T', description: 'd',
        basedOn: Array.from({ length: 11 }, (_, i) => `tf_x${i}`),
      })
      expect(overflow.ok).toBe(false)
      expect(overflow.code).toBe('format')
    } finally {
      await cleanup(dir)
    }
  })

  it('pins 继承：缺省取第一父，显式传入覆盖', async () => {
    const dir = await tempDir()
    try {
      const { engine, adapter } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const parentId = await createDoneTask(engine, '父任务 A', 'req-pa', '/tmp/ws-a')
      const parent = taskOf(engine, parentId)
      expect(parent.contract.pins.workspace).toBe('/tmp/ws-a')

      // 子任务不传 workspace → 继承第一父
      const child1 = await engine.dispatch({
        type: 'createTask', requestId: 'req-c1', title: '接续一', description: 'd', basedOn: [parentId],
      })
      expect(child1.ok).toBe(true)
      expect(taskOf(engine, child1.taskId!).contract.pins.workspace).toBe('/tmp/ws-a')

      // 子任务显式传 workspace → 覆盖继承
      const child2 = await engine.dispatch({
        type: 'createTask', requestId: 'req-c2', title: '接续二', description: 'd',
        basedOn: [parentId], pins: { workspace: '/tmp/ws-explicit' },
      })
      expect(child2.ok).toBe(true)
      expect(taskOf(engine, child2.taskId!).contract.pins.workspace).toBe('/tmp/ws-explicit')
      void adapter
    } finally {
      await cleanup(dir)
    }
  })

  it('分叉与合流：一拖二 depth 同级，合流孙任务 depth 取 max+1', async () => {
    const dir = await tempDir()
    try {
      const { engine } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const parentId = await createDoneTask(engine, '根任务', 'req-root')
      const parentDepth0 = taskOf(engine, parentId)
      // 普通任务不落 depth 字段（undefined = 0 层级语义）
      expect(parentDepth0.depth).toBeUndefined()

      // 分叉：同一父接续两次
      const fork1 = await engine.dispatch({ type: 'createTask', requestId: 'req-f1', title: '分叉一', description: 'd', basedOn: [parentId] })
      const fork2 = await engine.dispatch({ type: 'createTask', requestId: 'req-f2', title: '分叉二', description: 'd', basedOn: [parentId] })
      expect(fork1.ok).toBe(true)
      expect(fork2.ok).toBe(true)
      expect(taskOf(engine, fork1.taskId!).depth).toBe(1)
      expect(taskOf(engine, fork2.taskId!).depth).toBe(1)

      // 两个分叉都走完主链路到 done，再合流
      for (const [i, fork] of [fork1, fork2].entries()) {
        await waitFor(() => {
          const s = statusOf(engine, fork.taskId!)()
          return s === 'review' || s === 'done' || s === 'in-progress' || s === 'ready'
        })
        // mock 全绿直到 review；若已越过（自动开工）则等 review 再批
        await waitFor(() => statusOf(engine, fork.taskId!)() === 'review')
        const ok = await engine.dispatch({ type: 'approveTask', requestId: `req-f${i + 1}:approve`, taskId: fork.taskId! })
        expect(ok.ok).toBe(true)
      }

      const merge = await engine.dispatch({
        type: 'createTask', requestId: 'req-merge', title: '合流集成', description: 'd',
        basedOn: [fork1.taskId!, fork2.taskId!],
      })
      expect(merge.ok).toBe(true)
      const merged = taskOf(engine, merge.taskId!)
      expect(merged.parentIds).toEqual([fork1.taskId, fork2.taskId])
      expect(merged.depth).toBe(2)
      // 交接摘要逐父独立：两个父各自成节
      const handoff = merged.events.find(e => e.kind === 'handoff')
      expect(handoff?.reason).toContain('【父任务】分叉一')
      expect(handoff?.reason).toContain('【父任务】分叉二')
    } finally {
      await cleanup(dir)
    }
  })

  it('renderHandoffDigest：逐父分节、含终检结论与交付物、无证据父有兜底行', async () => {
    const dir = await tempDir()
    try {
      const { engine } = createEngine(path.join(dir, 'ledger.json'))
      await engine.boot()
      const withEvidence = await createDoneTask(engine, '有终检证据的任务', 'req-ev')
      const parentA = taskOf(engine, withEvidence)
      // 手工造一个无任务级终检证据的 done 任务（存量口径）
      const noEv = await engine.dispatch({ type: 'createTask', requestId: 'req-noev-p', title: '无证据任务', description: 'd', autoDecompose: false })
      const draft = taskOf(engine, noEv.taskId!)
      draft.status = 'done'
      const digest = renderHandoffDigest([parentA, draft])
      expect(digest).toContain('【父任务】有终检证据的任务')
      expect(digest).toContain('【父任务】无证据任务')
      expect(digest).toContain('终检证据：无')
      expect(digest).toContain('终检结论：自检')
      // 逐父独立：分节符出现两次
      expect(digest.split('【父任务】')).toHaveLength(3)
    } finally {
      await cleanup(dir)
    }
  })
})
