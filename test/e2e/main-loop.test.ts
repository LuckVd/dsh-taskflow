/**
 * M1 出口标准 E2E（REQUIREMENTS.md §8）：
 * 「主流程端到端可跑通：一个真实任务从一句话到 done（含一次打回迭代）」
 *
 * 场景：用户一句话创建任务（无验收标准）→ AI 拆解（补全验收）→ 串行执行 →
 * 第一份证据有瑕疵被人工打回（批语注入）→ 第二轮修正后证据齐全 →
 * 子任务级批准 + 任务级终批 → done；全程事件时间线完整可回放。
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_CONFIG, TaskflowEngine } from '../../src/host/engine.ts'
import { LedgerStore } from '../../src/host/ledger.ts'
import { MockSessionAdapter, buildPassingEvidence } from '../../src/host/mock/session-adapter.ts'
import { cleanup, ledgerOf, tempDir, waitFor } from '../helpers.ts'

describe('E2E 主流程：一句话 → done（含一次打回迭代）', () => {
  it('完整闭环 + 全程留痕', async () => {
    const dir = await tempDir('taskflow-e2e-')
    try {
      const box: { engine?: TaskflowEngine } = {}
      const adapter = new MockSessionAdapter({ getLedger: () => box.engine!.getState().ledger })
      const engine = new TaskflowEngine(
        new LedgerStore(path.join(dir, 'ledger.json')),
        adapter,
        DEFAULT_ENGINE_CONFIG,
      )
      box.engine = engine
      await engine.boot()

      // ── 1. 一句话创建（US-01：只填描述即可；验收留空）──
      const created = await engine.dispatch({
        type: 'createTask',
        requestId: 'e2e-create',
        title: '给计算器加上百分比按钮',
        description: '计算器 Web 界面缺少百分比运算，补上按钮、逻辑与单元测试。',
      })
      expect(created.ok, JSON.stringify(created)).toBe(true)
      const taskId = created.taskId!

      // ── 2. AI 拆解（US-03：自动拆解成子任务并开工；US-01：验收由 AI 补全）──
      await waitFor(() => ledgerOf(engine).tasks.find(t => t.id === taskId)?.status === 'in-progress')
      await waitFor(() => task0(engine, taskId).subtasks.length === 2)

      // ── 3. 串行执行 + 第一轮证据（US-06：完成证明而非一句做完了）──
      await waitFor(() => task0(engine, taskId).subtasks.every(s => s.status === 'review'))
      const firstSub = task0(engine, taskId).subtasks[0]!
      expect(firstSub.evidence!.changesSummary).toBeTruthy()
      expect(firstSub.evidence!.verification.length).toBeGreaterThan(0)
      expect(firstSub.evidence!.selfCheck).toHaveLength(firstSub.acceptance.length)
      // T5 延后（2026-09-11 语义）：全部子任务证据齐备 → AI 任务级终检 → 才进 review
      await waitFor(() => task0(engine, taskId).status === 'review')
      expect(adapter.finalizeRuns.length).toBeGreaterThanOrEqual(1)
      expect(task0(engine, taskId).evidence).toBeDefined()
      expect(task0(engine, taskId).evidence!.selfCheck).toHaveLength(task0(engine, taskId).contract.acceptance.length)

      // ── 4. 人工打回：批语必填，注入下一轮（US-07/US-08）；返工范围由 AI triage 定位 ──
      const rejected = await engine.dispatch({
        type: 'rejectSubtask',
        requestId: 'e2e-reject',
        taskId,
        comment: '百分比按钮在除数为零时抛异常；请处理边界并补测试用例。',
      })
      expect(rejected.ok).toBe(true)
      expect(rejected.subtaskIds).toEqual([]) // 返回值为空：范围由 AI 异步定位
      expect(adapter.triageRuns.length).toBe(1)
      expect(adapter.triageRuns[0]!.prompt).toContain('除数为零')
      await waitFor(() => task0(engine, taskId).round === 2)
      // 下一轮提示词包含批语原文 + 来源声明（§4.7/§7.3）
      await waitFor(() => adapter.executionRuns.some(r => r.round >= 2 && r.prompt.includes('除数为零')))
      const round2Prompt = adapter.executionRuns.find(r => r.round >= 2)!.prompt
      expect(round2Prompt).toContain('人类验收批语')
      expect(round2Prompt).toContain('未经本会话审阅')

      // ── 5. 第二轮证据齐全 → 待验收 ──
      await waitFor(() => task0(engine, taskId).status === 'review')
      expect(task0(engine, taskId).round).toBe(2)
      expect(firstSub.evidenceHistory).toHaveLength(1) // 第一轮证据留档

      // ── 6. 子任务级批准（US-07 批准）+ 任务级终批（Q4：一次性批准全部）──
      const approveSub = await engine.dispatch({
        type: 'approveSubtask',
        requestId: 'e2e-approve-sub',
        taskId,
        subtaskId: firstSub.id,
      })
      expect(approveSub.ok).toBe(true)
      expect(task0(engine, taskId).subtasks[0]!.status).toBe('done')

      const approveTask = await engine.dispatch({ type: 'approveTask', requestId: 'e2e-approve-task', taskId })
      expect(approveTask.ok).toBe(true)
      const task = task0(engine, taskId)
      expect(task.status).toBe('done')
      expect(task.subtasks.every(s => s.status === 'done')).toBe(true)

      // ── 7. 全程留痕（US-09：谁、何时、从哪到哪、为什么）──
      const timeline = [...task.events]
      const statuses = timeline.filter(e => e.from !== e.to || e.from === null).map(e => `${e.from ?? '∅'}→${e.to}`)
      for (const expected of [
        '∅→draft',
        'draft→decomposing',
        'decomposing→ready',
        'ready→in-progress',
        'in-progress→review',
        'review→in-progress', // 打回 T7
        'in-progress→review', // 第二轮证据齐全 T5
        'review→done', // T6
      ]) {
        expect(statuses, `时间线缺 ${expected}：${statuses.join(' | ')}`).toContain(expected)
      }
      const rejectEvent = timeline.find(e => e.to === 'in-progress' && e.actor === 'human' && (e.reason ?? '').includes('打回'))
      expect(rejectEvent).toBeDefined()
      // 子任务级事件：S1 落库、S2 启动、S3 证据、S5 打回、S4 批准
      for (const sub of task.subtasks) {
        const subStatuses = sub.history.filter(e => e.from !== e.to).map(e => `${e.from ?? '∅'}→${e.to}`)
        expect(subStatuses).toContain('∅→pending')
        expect(subStatuses).toContain('pending→in-progress')
        expect(subStatuses).toContain('review→rejected')
        expect(subStatuses).toContain('rejected→in-progress')
        expect(subStatuses).toContain('in-progress→review')
        expect(subStatuses.at(-1)).toBe('review→done')
        expect(sub.sessionId).toBeDefined()
        expect(sub.sessionIds.length).toBeGreaterThanOrEqual(2) // 两轮各一会话（US-05 可围观）
      }
      // 批语原文在子任务事件中
      expect(task.subtasks[0]!.history.some(e => e.reason?.includes('除数为零'))).toBe(true)

      // ── 8. 归档（US-13）──
      const archived = await engine.dispatch({ type: 'archiveTask', requestId: 'e2e-archive', taskId })
      expect(archived.ok).toBe(true)
      expect(task0(engine, taskId).status).toBe('archived')
    } finally {
      await cleanup(dir)
    }
  })
})

function task0(engine: TaskflowEngine, taskId: string) {
  const task = ledgerOf(engine).tasks.find(t => t.id === taskId)
  if (task === undefined) throw new Error(`task ${taskId} missing`)
  return task
}

describe('E2E 审批模式：提权审批两档裁决（§7.1b）', () => {
  it('放行支线：审批 pending → 完全放行 → 证据齐全进验收；拒绝支线：拒绝 → 报障受阻', async () => {
    const dir = await tempDir('taskflow-e2e-appr-')
    try {
      const box: { engine?: TaskflowEngine } = {}
      const adapter = new MockSessionAdapter({ getLedger: () => box.engine!.getState().ledger })
      const asked = new Set<string>()
      adapter.executionBehavior = async input => {
        // 每任务首个执行会话发起提权审批（后续子任务直接执行，保证收束）
        if (!asked.has(input.taskId)) {
          asked.add(input.taskId)
          const decision = await input.approvals.request({
            sessionId: input.sessionId,
            toolName: 'write',
            reason: '需要写入产物文件',
          })
          if (decision === 'rejected') {
            await input.tools.reportBlocker('提权被拒：无法写文件')
            return
          }
        }
        const result = await input.tools.submitEvidence(buildPassingEvidence(box.engine!.getState().ledger, input.subtaskId))
        if (!result.accepted) throw new Error(`evidence rejected: ${result.correction}`)
      }
      const engine = new TaskflowEngine(new LedgerStore(path.join(dir, 'ledger.json')), adapter, DEFAULT_ENGINE_CONFIG)
      box.engine = engine
      await engine.boot()

      // ── 放行支线：一句话创建（approval 模式）→ 审批 → 完全放行 → review ──
      const created = await engine.dispatch({
        type: 'createTask',
        requestId: 'e2e-appr-create',
        title: '生成周报 markdown',
        description: '汇总本周进展，写成 markdown 文件。',
        pins: { executionMode: 'approval' },
      })
      expect(created.ok).toBe(true)
      const taskId = created.taskId!

      await waitFor(() => task0(engine, taskId).approvals?.some(a => a.status === 'pending') ?? false)
      // 子任务事件与执行会话都带审批留痕
      expect(task0(engine, taskId).subtasks[0]!.history.some(e => e.kind === 'approval-requested')).toBe(true)
      expect(adapter.executionRuns[0]?.executionMode).toBe('approval')
      const record = task0(engine, taskId).approvals![0]!

      const allowed = await engine.dispatch({
        type: 'decideApproval', requestId: 'e2e-appr-allow', taskId, approvalId: record.id, decision: 'allow',
      })
      expect(allowed.ok).toBe(true)
      await waitFor(() => task0(engine, taskId).status === 'review')
      expect(task0(engine, taskId).approvals![0]!.status).toBe('elevated')
      expect(task0(engine, taskId).subtasks.every(s => s.evidence !== undefined)).toBe(true)

      // ── 拒绝支线：第二个任务，拒绝提权 → 报障 → blocked ──
      const created2 = await engine.dispatch({
        type: 'createTask',
        requestId: 'e2e-appr-create-2',
        title: '清理构建缓存',
        description: '删除过期缓存文件并验证构建仍可通过。',
        pins: { executionMode: 'approval' },
      })
      expect(created2.ok).toBe(true)
      const taskId2 = created2.taskId!
      await waitFor(() => task0(engine, taskId2).approvals?.some(a => a.status === 'pending') ?? false)
      const record2 = task0(engine, taskId2).approvals![0]!

      const rejected = await engine.dispatch({
        type: 'decideApproval', requestId: 'e2e-appr-reject', taskId: taskId2, approvalId: record2.id,
        decision: 'reject', note: '缓存目录只读，先别动',
      })
      expect(rejected.ok).toBe(true)
      await waitFor(() => task0(engine, taskId2).status === 'blocked')
      expect(task0(engine, taskId2).approvals![0]!.status).toBe('rejected')
      expect(task0(engine, taskId2).subtasks[0]!.history.some(e => e.kind === 'blocker-reported')).toBe(true)
      // 拒绝批语留痕
      expect(task0(engine, taskId2).subtasks[0]!.history.some(e => (e.reason ?? '').includes('先别动'))).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })
})
