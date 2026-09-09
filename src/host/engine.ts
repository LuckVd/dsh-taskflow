/**
 * Taskflow 引擎：Host 权威编排层。
 *
 * 职责：action 分发（幂等去重）、拆解会话编排、子任务调度（M1 全局串行）、
 * 证据门（无证据不进验收）、验收/打回迭代循环、重启恢复。
 * 会话的创建/驱动/观测全部委托 {@link SessionAdapter}（真实 dsh 适配器或测试 mock）。
 *
 * 调度模型：子任务 status=in-progress 且 sessionId=undefined 表示「已排队待启动」；
 * 调度器（collectLaunches）原子地取号（attempt+1、分配 sessionId）并启动会话。
 *
 * @module dsh-taskflow/host
 */

import { materializeAcceptance, randomId, validateActionShape } from '../protocol/actions.ts'
import type { TaskflowAction } from '../protocol/actions.ts'
import { DecomposeValidationError, validateDecomposeOutput } from '../protocol/decompose.ts'
import type { DecomposeOutput } from '../protocol/decompose.ts'
import { EvidenceRejectedError, normalizeEvidence, parseEvidenceInput, renderEvidenceCorrection } from '../protocol/evidence.ts'
import type { DispatchResult, EngineState, Evidence, Ledger, Subtask, Task } from '../protocol/types.ts'
import { LedgerStore, LedgerWriteError } from './ledger.ts'
import { renderDecomposePrompt, renderExecutionPrompt } from './prompts.ts'
import {
  IllegalTransitionError,
  allSubtasksEvidencedOrDone,
  appendCreationEvent,
  appendSubtaskCreationEvent,
  appendSubtaskNote,
  appendTaskNote,
  hasActiveSubtasks,
  transitionSubtask,
  transitionTask,
} from './statemachine.ts'

// —— 适配器契约 ——

export interface DecomposeSessionInput {
  taskId: string
  sessionId: string
  prompt: string
  workspace: string
  presetId: string | null
  /** 任务声明的执行权限（适配器据此应用权限预设）。 */
  permission: string
}

export interface ExecutionSessionInput {
  taskId: string
  subtaskId: string
  sessionId: string
  /** 本轮迭代轮次与启动序号（adapter 可用于标注/复用）。 */
  round: number
  attempt: number
  prompt: string
  workspace: string
  presetId: string | null
  /** 任务声明的执行权限（适配器据此应用权限预设）。 */
  permission: string
  /** Host 权威工具面：校验与落库都在引擎内完成（不变量 1/3）。 */
  tools: AgentToolSurface
}

export interface AgentToolSurface {
  submitEvidence(payload: unknown): Promise<{ accepted: true } | { accepted: false; correction: string }>
  reportBlocker(reason: string): Promise<{ accepted: boolean }>
  updateProgress(note: string): Promise<{ accepted: boolean }>
}

export type DecomposeResult =
  | { kind: 'ok'; output: unknown }
  | { kind: 'failed'; error: string }

export type ExecutionOutcome =
  | { kind: 'completed' }
  | { kind: 'crashed'; error: string }

export interface SessionAdapter {
  readonly kind: string
  runDecomposeSession(input: DecomposeSessionInput): Promise<DecomposeResult>
  runExecutionSession(input: ExecutionSessionInput): Promise<ExecutionOutcome>
  /** 重启恢复查询：该会话是否有持久记录（§4.4 确定性恢复）。 */
  hasSessionRecord(sessionId: string): Promise<boolean>
  /** 尽力而为终止运行中会话（T9）。 */
  cancelSession(sessionId: string): Promise<void>
  /** 可选：重启后接管既有会话（re-attach 并等待结果）。 */
  adoptSession?(input: ExecutionSessionInput): Promise<ExecutionOutcome>
}

// —— 配置与常量 ——

export interface EngineConfig {
  /** 同时运行的子任务会话数（M1 默认 1 = 全局串行，Q2 裁决）。 */
  maxConcurrentSubtasks: number
  /** 会话默认权限（§7.1 权限确认门的基线）。 */
  sessionDefaultPermission: string
  /** 单轮内会话启动次数上限（§8：自动重启至 2 次）。 */
  maxSessionAttempts: number
  /** 拆解会话自动重试次数（§4.3：失败重试 1 次）。 */
  decomposeRetries: number
  /** M1 忽略 deps（仅展示）；true 时启用 DAG 就绪守卫（M2，Q2 裁决）。 */
  enforceDeps: boolean
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxConcurrentSubtasks: 1,
  sessionDefaultPermission: 'read-only',
  maxSessionAttempts: 2,
  decomposeRetries: 1,
  enforceDeps: false,
}

/** 迭代上限默认值（§4.1：默认 3）。 */
export const DEFAULT_MAX_ROUNDS = 3
/** 每子任务保留的证据历史条数（NFR-05 有界）。 */
const MAX_EVIDENCE_HISTORY = 20

// —— 错误 ——

export type DispatchErrorCode = 'format' | 'not-found' | 'guard' | 'invalid-state' | 'storage' | 'internal'

export type { DispatchResult, EngineState } from '../protocol/types.ts'

export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

interface PendingLaunch {
  taskId: string
  subtaskId: string
  sessionId: string
}

// —— 引擎 ——

export class TaskflowEngine {
  private readonly dedup = new Map<string, DispatchResult>()
  private readonly decomposeAttempts = new Map<string, number>()
  private disposed = false
  private booted = false

  constructor(
    private readonly store: LedgerStore,
    private readonly adapter: SessionAdapter,
    readonly config: EngineConfig = DEFAULT_ENGINE_CONFIG,
  ) {}

  /** 加载 + 确定性恢复（NFR-03：运行中的可观察接管，未启动的取消不重发）。 */
  async boot(): Promise<void> {
    if (this.booted) throw new GuardError('engine already booted')
    this.booted = true
    await this.store.load()
    const ledger = this.store.snapshot()
    for (const task of ledger.tasks) {
      if (task.status === 'decomposing') {
        await this.recoverDecomposing(task.id)
        continue
      }
      if (task.status !== 'in-progress') continue
      for (const sub of task.subtasks) {
        if (sub.status !== 'in-progress' || sub.sessionId === undefined) continue
        await this.recoverRunningSubtask(task.id, sub.id, sub.sessionId)
      }
    }
    await this.pump()
  }

  getState(): EngineState {
    return {
      ledger: this.store.snapshot(),
      health: { corrupt: this.store.health.corrupt, lastWriteFailed: this.store.health.lastWriteFailed },
    }
  }

  subscribe(listener: (ledger: Ledger) => void): () => void {
    return this.store.subscribe(listener)
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }

  // —— 恢复 ——

  private async recoverDecomposing(taskId: string): Promise<void> {
    const snapshot = this.store.snapshot()
    const task = snapshot.tasks.find(t => t.id === taskId)
    if (task === undefined) return
    const lastSession = task.decomposeSessionIds.at(-1)
    const hasRecord = lastSession === undefined ? false : await this.adapter.hasSessionRecord(lastSession)
    if (!hasRecord) {
      // 无记录：该次拆解从未真正发出 → 重试一次（attempt 计入）
      const attempt = (this.decomposeAttempts.get(taskId) ?? 1) + 1
      this.decomposeAttempts.set(taskId, attempt)
      if (attempt <= this.config.decomposeRetries + 1) {
        await this.startDecomposeInternal(taskId, attempt).catch(() => undefined)
      } else {
        await this.mutateQuiet(ledger => {
          const t = findTask(ledger, taskId)
          if (t && t.status === 'decomposing') {
            transitionTask(t, 'blocked', { actor: 'system', reason: `重启恢复：拆解会话无记录且重试耗尽（attempt ${attempt}）` })
          }
        })
      }
      return
    }
    // 有记录：可观察接管（M1 转人工重新拆解，事件留痕）
    await this.mutateQuiet(ledger => {
      const t = findTask(ledger, taskId)
      if (t === null) return
      appendTaskNote(t, {
        actor: 'system',
        kind: 'recovery',
        reason: `重启恢复：拆解会话 ${lastSession} 存在记录，转人工重新拆解`,
        refs: { sessionId: lastSession },
      })
      if (t.status === 'decomposing') {
        transitionTask(t, 'blocked', { actor: 'system', reason: '重启恢复：拆解会话待人工接管（可重新拆解）' })
      }
    })
  }

  private async recoverRunningSubtask(taskId: string, subtaskId: string, sessionId: string): Promise<void> {
    const hasRecord = await this.adapter.hasSessionRecord(sessionId)
    if (hasRecord && this.adapter.adoptSession !== undefined) {
      const snapshot = this.store.snapshot()
      const task = snapshot.tasks.find(t => t.id === taskId)
      const sub = task?.subtasks.find(s => s.id === subtaskId)
      if (task !== undefined && sub !== undefined && sub.sessionId === sessionId) {
        const input = this.buildExecutionInput(task, sub, sessionId)
        if (input !== null) {
          await this.mutateQuiet(ledger => {
            const t = findTask(ledger, taskId)
            const s = t && findSubtask(t, subtaskId)
            if (t && s) appendSubtaskNote(s, { actor: 'system', kind: 'recovery', reason: `重启恢复：接管会话 ${sessionId}`, refs: { sessionId } })
          })
          void this.awaitAdopted(taskId, subtaskId, sessionId, input)
          return
        }
      }
    }
    await this.mutateQuiet(ledger => {
      const t = findTask(ledger, taskId)
      const s = t === null ? undefined : findSubtask(t, subtaskId)
      if (t === null || s === undefined || s.status !== 'in-progress' || s.sessionId !== sessionId) return
      if (hasRecord) {
        appendSubtaskNote(s, {
          actor: 'system',
          kind: 'recovery',
          reason: `重启恢复：会话 ${sessionId} 存在记录，转 blocked 等人工接管`,
          refs: { sessionId },
        })
        transitionSubtask(s, 'blocked', { actor: 'system', reason: '重启恢复：待人工接管' })
        if (t.status === 'in-progress') {
          transitionTask(t, 'blocked', { actor: 'system', reason: `重启恢复：子任务 ${s.id} 待人工接管` })
        }
      } else {
        // 无记录：取消该次运行（不重发），子任务回到排队态由调度器重新取号
        appendSubtaskNote(s, {
          actor: 'system',
          kind: 'recovery',
          reason: `重启恢复：会话 ${sessionId} 无记录，取消本次运行重新排队`,
          refs: { sessionId },
        })
        s.sessionId = undefined
      }
    })
  }

  private async awaitAdopted(taskId: string, subtaskId: string, sessionId: string, input: ExecutionSessionInput): Promise<void> {
    if (this.adapter.adoptSession === undefined) return
    let outcome: ExecutionOutcome
    try {
      outcome = await this.adapter.adoptSession(input)
    } catch (error) {
      outcome = { kind: 'crashed', error: errorMessage(error) }
    }
    if (this.disposed) return
    await this.handleExecutionOutcome(taskId, subtaskId, sessionId, outcome)
  }

  // —— Action 分发 ——

  async dispatch(raw: unknown): Promise<DispatchResult> {
    let action: TaskflowAction
    try {
      action = validateActionShape(raw)
    } catch (error) {
      return { ok: false, code: 'format', error: errorMessage(error) }
    }
    const seen = this.dedup.get(action.requestId)
    if (seen !== undefined) return seen

    const result = await this.executeAction(action)
    if (this.dedup.size > 2048) {
      const oldest = this.dedup.keys().next().value
      if (oldest !== undefined) this.dedup.delete(oldest)
    }
    this.dedup.set(action.requestId, result)
    return result
  }

  private async executeAction(action: TaskflowAction): Promise<DispatchResult> {
    try {
      switch (action.type) {
        case 'createTask':
          return await this.actionCreateTask(action)
        case 'startDecompose':
          return await this.actionStartDecompose(action)
        case 'updateContract':
          return await this.actionUpdateContract(action)
        case 'editSubtasks':
          return await this.actionEditSubtasks(action)
        case 'startImplementation':
          return await this.actionStartImplementation(action)
        case 'approveSubtask':
          return await this.actionApproveSubtask(action)
        case 'rejectSubtask':
          return await this.actionRejectSubtask(action)
        case 'approveTask':
          return await this.actionApproveTask(action)
        case 'cancelTask':
          return await this.actionCancelTask(action)
        case 'archiveTask':
          return await this.actionArchiveTask(action)
        case 'retryBlocked':
          return await this.actionRetryBlocked(action)
        case 'raiseMaxRounds':
          return await this.actionRaiseMaxRounds(action)
      }
    } catch (error) {
      if (error instanceof IllegalTransitionError) return { ok: false, code: 'invalid-state', error: error.message }
      if (error instanceof LedgerWriteError) return { ok: false, code: 'storage', error: error.message }
      if (error instanceof GuardError) return { ok: false, code: 'guard', error: error.message }
      return { ok: false, code: 'internal', error: errorMessage(error) }
    }
  }

  // —— 各 action 处理器 ——

  private async actionCreateTask(action: Extract<TaskflowAction, { type: 'createTask' }>): Promise<DispatchResult> {
    const taskId = `tf_${randomId()}`
    await this.store.mutate(ledger => {
      const acceptance = action.acceptance?.map(item => ({ id: `ac_${randomId()}`, text: item.text })) ?? []
      const task: Task = {
        id: taskId,
        title: action.title,
        description: action.description,
        contract: {
          objective: action.objective ?? action.title,
          acceptance,
          // 留空 = 拆解时 AI 补全（ai-drafted 为待补状态标记）
          sourceOfAcceptance: acceptance.length > 0 ? 'human' : 'ai-drafted',
          pins: {
            workspace: action.pins?.workspace ?? '',
            presetId: action.pins?.presetId ?? null,
            permission: action.pins?.permission ?? this.config.sessionDefaultPermission,
          },
        },
        status: 'draft',
        subtasks: [],
        events: [],
        round: 1,
        maxRounds: action.maxRounds ?? DEFAULT_MAX_ROUNDS,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: 'human',
        autoStart: action.autoStart ?? true,
        permissionConfirmed: !this.needsPermissionConfirm(action.pins?.permission ?? this.config.sessionDefaultPermission),
        decomposeSessionIds: [],
      }
      appendCreationEvent(task, '创建任务（T1）')
      ledger.tasks.push(task)
    })
    if (action.autoDecompose ?? true) {
      return this.actionStartDecompose({ type: 'startDecompose', requestId: `${action.requestId}:decompose`, taskId })
    }
    return { ok: true, revision: this.currentRevision(), taskId }
  }

  private async actionStartDecompose(action: Extract<TaskflowAction, { type: 'startDecompose' }>): Promise<DispatchResult> {
    const task = this.findTask(action.taskId)
    if (task === null) return { ok: false, code: 'not-found', error: `task ${action.taskId} not found` }
    if (task.status !== 'draft' && task.status !== 'blocked') {
      return { ok: false, code: 'guard', error: `startDecompose 仅允许 draft/blocked 状态（当前 ${task.status}）` }
    }
    if (task.description.trim().length === 0) {
      return { ok: false, code: 'guard', error: 'T2 守卫：description 非空' }
    }
    await this.startDecomposeInternal(action.taskId, 1)
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  private async startDecomposeInternal(taskId: string, attempt: number): Promise<void> {
    const { result } = await this.store.mutate(ledger => {
      const task = findTask(ledger, taskId)
      if (task === null) throw new GuardError(`task ${taskId} not found`)
      const sessionId = `tfs_${taskId}_d${attempt}_${randomId(4)}`
      if (task.status === 'decomposing') {
        // 重试路径：已在拆解中，不重复 T2，仅追加会话与留痕
        appendTaskNote(task, { actor: 'system', kind: 'decompose-retry', reason: `拆解重试 attempt ${attempt}`, refs: { sessionId } })
      } else {
        transitionTask(task, 'decomposing', {
          actor: task.status === 'draft' ? 'human' : 'system',
          reason: task.status === 'draft' ? '开始拆解（T2）' : `重新拆解 attempt ${attempt}`,
          refs: { sessionId },
        })
      }
      task.decomposeSessionIds.push(sessionId)
      this.decomposeAttempts.set(taskId, attempt)
      return {
        taskId: task.id,
        sessionId,
        prompt: renderDecomposePrompt(task),
        workspace: task.contract.pins.workspace,
        presetId: task.contract.pins.presetId,
        permission: task.contract.pins.permission,
      }
    })
    void this.runDecompose(result).catch(() => undefined)
  }

  private async runDecompose(input: DecomposeSessionInput): Promise<void> {
    if (this.disposed) return
    let result: DecomposeResult
    try {
      result = await this.adapter.runDecomposeSession(input)
    } catch (error) {
      result = { kind: 'failed', error: errorMessage(error) }
    }
    if (this.disposed) return

    if (result.kind === 'ok') {
      try {
        const output = validateDecomposeOutput(result.output)
        await this.handleDecomposeSuccess(input.taskId, input.sessionId, output)
        return
      } catch (error) {
        const message = error instanceof DecomposeValidationError || error instanceof GuardError
          ? error.message
          : errorMessage(error)
        await this.handleDecomposeFailure(input.taskId, input.sessionId, message)
        return
      }
    }
    await this.handleDecomposeFailure(input.taskId, input.sessionId, result.error)
  }

  private async handleDecomposeSuccess(taskId: string, sessionId: string, output: DecomposeOutput): Promise<void> {
    await this.store.mutate(ledger => {
      const task = findTask(ledger, taskId)
      if (task === null || task.status !== 'decomposing') return

      // FR-02：验收标准合并
      const existing = task.contract.acceptance
      if (existing.length === 0) {
        task.contract.acceptance = output.taskAcceptance.map(item => ({ id: `ac_${randomId()}`, text: item.text }))
        task.contract.sourceOfAcceptance = 'ai-drafted'
      } else {
        if (output.taskAcceptance.length !== existing.length) {
          throw new GuardError(
            `拆解产物 taskAcceptance（${output.taskAcceptance.length} 条）必须与用户验收标准（${existing.length} 条）等长逐条细化（FR-02：不可增删替换）`,
          )
        }
        task.contract.originalHumanAcceptance = structuredClone(existing)
        task.contract.acceptance = existing.map((origin, i) => ({
          id: origin.id,
          text: output.taskAcceptance[i]?.text ?? origin.text,
        }))
        task.contract.sourceOfAcceptance = 'ai-refined'
      }

      // 子任务落库（S1）
      const start = task.subtasks.length
      output.subtasks.forEach((item, i) => {
        const subtask: Subtask = {
          id: `${taskId}_s${start + i + 1}`,
          title: item.title,
          detail: item.detail,
          acceptance: item.acceptance.map(ac => ({ id: `ac_${randomId()}`, text: ac.text })),
          deps: item.deps.map(dep => `${taskId}_s${Number.parseInt(dep.slice(1), 10) + start}`),
          status: 'pending',
          round: 1,
          history: [],
          sessionIds: [],
          attempt: 0,
          evidenceHistory: [],
          progressNotes: [],
        }
        task.subtasks.push(subtask)
        appendSubtaskCreationEvent(subtask, '拆解产物落库（S1）')
      })
      transitionTask(task, 'ready', {
        actor: 'system',
        reason: `拆解完成：${task.subtasks.length} 个子任务（T3）`,
        refs: { sessionId },
      })
      if (task.autoStart) {
        transitionTask(task, 'in-progress', { actor: 'system', reason: 'autoStart：拆解完成自动开工（T4）' })
      }
    })
    await this.pump()
  }

  private async handleDecomposeFailure(taskId: string, sessionId: string, reason: string): Promise<void> {
    const attempt = this.decomposeAttempts.get(taskId) ?? 1
    if (attempt <= this.config.decomposeRetries) {
      await this.mutateQuiet(ledger => {
        const task = findTask(ledger, taskId)
        if (task === null || task.status !== 'decomposing') return
        appendTaskNote(task, {
          actor: 'system',
          kind: 'decompose-retry',
          reason: `拆解失败（${reason}），自动重试`,
          refs: { sessionId },
        })
      })
      await this.startDecomposeInternal(taskId, attempt + 1)
      return
    }
    await this.mutateQuiet(ledger => {
      const task = findTask(ledger, taskId)
      if (task === null || task.status !== 'decomposing') return
      transitionTask(task, 'blocked', { actor: 'system', reason: `拆解失败且重试耗尽：${reason}（T3′）`, refs: { sessionId } })
    })
  }

  private async actionUpdateContract(action: Extract<TaskflowAction, { type: 'updateContract' }>): Promise<DispatchResult> {
    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      if (task.status !== 'draft' && task.status !== 'ready') {
        throw new GuardError(`updateContract 仅允许 draft/ready 状态（当前 ${task.status}）`)
      }
      if (action.objective !== undefined) task.contract.objective = action.objective
      if (action.acceptance !== undefined) {
        task.contract.acceptance = materializeAcceptance(action.acceptance, task.contract.acceptance)
        task.contract.sourceOfAcceptance = 'human'
        delete task.contract.originalHumanAcceptance
      }
      if (action.pins !== undefined) {
        let permissionChanged = false
        if (action.pins.workspace !== undefined) task.contract.pins.workspace = action.pins.workspace
        if (action.pins.presetId !== undefined) task.contract.pins.presetId = action.pins.presetId
        if (action.pins.permission !== undefined && action.pins.permission !== task.contract.pins.permission) {
          task.contract.pins.permission = action.pins.permission
          permissionChanged = true
        }
        if (permissionChanged) {
          // §7.1：pins 变更后确认状态重置（re-arm）
          task.permissionConfirmed = !this.needsPermissionConfirm(task.contract.pins.permission)
        }
      }
      if (action.autoStart !== undefined) task.autoStart = action.autoStart
      task.updatedAt = Date.now()
      appendTaskNote(task, { actor: 'human', kind: 'contract-edited', reason: '编辑合同' })
    })
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  private async actionEditSubtasks(action: Extract<TaskflowAction, { type: 'editSubtasks' }>): Promise<DispatchResult> {
    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      if (task.status !== 'ready') {
        throw new GuardError(`editSubtasks 仅允许 ready 状态（US-04：拆解后、开工前编辑；当前 ${task.status}）`)
      }
      for (const id of action.remove ?? []) {
        const sub = findSubtask(task, id)
        if (sub === undefined) throw new GuardError(`subtask ${id} not found`)
        if (sub.status !== 'pending') throw new GuardError(`subtask ${id} 状态为 ${sub.status}，仅 pending 可删除`)
        task.subtasks = task.subtasks.filter(s => s.id !== id)
      }
      for (const item of action.update ?? []) {
        const sub = findSubtask(task, item.id)
        if (sub === undefined) throw new GuardError(`subtask ${item.id} not found`)
        if (sub.status !== 'pending') throw new GuardError(`subtask ${item.id} 状态为 ${sub.status}，仅 pending 可编辑`)
        if (item.title !== undefined) sub.title = item.title
        if (item.detail !== undefined) sub.detail = item.detail
        if (item.acceptance !== undefined) {
          sub.acceptance = materializeAcceptance(item.acceptance, sub.acceptance)
        }
      }
      const start = task.subtasks.length
      for (const [i, item] of (action.add ?? []).entries()) {
        const deps = (item.deps ?? []).map(dep => {
          const byTitle = task.subtasks.find(s => s.title === dep)
          if (byTitle !== undefined) return byTitle.id
          const byId = task.subtasks.find(s => s.id === dep)
          if (byId !== undefined) return byId.id
          const byIndex = task.subtasks.find(s => s.id === `${action.taskId}_s${Number.parseInt(dep.slice(1), 10)}`)
          if (byIndex !== undefined) return byIndex.id
          throw new GuardError(`add[${i}] 依赖的子任务不存在：${dep}`)
        })
        const subtask: Subtask = {
          id: `${task.id}_s${start + 1}`,
          title: item.title,
          detail: item.detail,
          acceptance: materializeAcceptance(item.acceptance),
          deps,
          status: 'pending',
          round: 1,
          history: [],
          sessionIds: [],
          attempt: 0,
          evidenceHistory: [],
          progressNotes: [],
        }
        task.subtasks.push(subtask)
        appendSubtaskCreationEvent(subtask, '人工新增子任务（US-04）')
      }
      if (task.subtasks.length === 0) throw new GuardError('编辑后子任务不能为空')
      task.updatedAt = Date.now()
      appendTaskNote(task, { actor: 'human', kind: 'subtasks-edited', reason: '人工编辑拆解结果' })
    })
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  private async actionStartImplementation(
    action: Extract<TaskflowAction, { type: 'startImplementation' }>,
  ): Promise<DispatchResult> {
    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      if (task.status !== 'ready' && !(task.status === 'in-progress' && action.confirmPermission === true)) {
        throw new GuardError(`startImplementation 仅允许 ready 状态（当前 ${task.status}）；in-progress 仅接受 confirmPermission 确认`)
      }
      if (this.needsPermissionConfirm(task.contract.pins.permission)) {
        if (action.confirmPermission === true) {
          task.permissionConfirmed = true
          appendTaskNote(task, { actor: 'human', kind: 'permission-confirmed', reason: '人工确认执行权限（§7.1）' })
        } else if (task.status === 'ready') {
          throw new GuardError('该任务执行权限高于会话默认，须在详情页显式确认（§7.1 权限确认门）')
        }
      }
      if (task.status === 'ready') {
        transitionTask(task, 'in-progress', { actor: 'human', reason: '开始实现（T4）' })
      }
    })
    await this.pump()
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  private async actionApproveSubtask(action: Extract<TaskflowAction, { type: 'approveSubtask' }>): Promise<DispatchResult> {
    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      if (task.status !== 'in-progress' && task.status !== 'review') {
        throw new GuardError(`approveSubtask 仅允许 in-progress/review 任务（当前 ${task.status}）`)
      }
      const sub = findSubtask(task, action.subtaskId)
      if (sub === undefined) throw new GuardError(`subtask ${action.subtaskId} not found`)
      if (sub.status !== 'review') throw new GuardError(`subtask ${action.subtaskId} 状态为 ${sub.status}，仅 review 可批准（S4）`)
      transitionSubtask(sub, 'done', { actor: 'human', reason: '人工批准（S4）', refs: { sessionId: sub.sessionId } })
      if (allSubtasksEvidencedOrDone(task) && task.status === 'in-progress') {
        transitionTask(task, 'review', { actor: 'system', reason: '全部子任务证据齐全/已批准，待人工终批（T5）' })
      }
    })
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId, subtaskIds: [action.subtaskId] }
  }

  private async actionRejectSubtask(action: Extract<TaskflowAction, { type: 'rejectSubtask' }>): Promise<DispatchResult> {
    const taskNow = this.findTask(action.taskId)
    if (taskNow === null) return { ok: false, code: 'not-found', error: `task ${action.taskId} not found` }
    if (taskNow.status !== 'in-progress' && taskNow.status !== 'review') {
      return { ok: false, code: 'guard', error: `rejectSubtask 仅允许 in-progress/review 任务（当前 ${taskNow.status}）` }
    }
    const inReview = taskNow.subtasks.filter(s => s.status === 'review')
    const selected = action.subtaskIds ?? defaultRejectScope(inReview)
    if (selected.length === 0) {
      return { ok: false, code: 'guard', error: '没有可打回的子任务（须处于待验收状态）' }
    }

    // 迭代上限守卫（T7′）
    if (taskNow.maxRounds !== null && taskNow.round + 1 > taskNow.maxRounds) {
      await this.mutateQuiet(ledger => {
        const task = findTask(ledger, action.taskId)
        if (task === null) return
        appendTaskNote(task, {
          actor: 'human',
          kind: 'reject-blocked',
          reason: `打回批语：${firstLine(action.comment)}`,
        })
        if (task.status === 'review' || task.status === 'in-progress') {
          transitionTask(task, 'blocked', {
            actor: 'system',
            reason: `打回时已达迭代上限（round ${task.round}/${task.maxRounds}，T7′）；可提高上限后继续`,
          })
        }
      })
      return { ok: true, revision: this.currentRevision(), taskId: action.taskId, subtaskIds: [] }
    }

    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      for (const subtaskId of selected) {
        const sub = findSubtask(task, subtaskId)
        if (sub === undefined) throw new GuardError(`subtask ${subtaskId} not found`)
        if (sub.status !== 'review') {
          throw new GuardError(`subtask ${subtaskId} 状态为 ${sub.status}，仅 review 可打回（S5）`)
        }
        // S5：review → rejected（落批语，原文注入下一轮）→ in-progress（重新排队）
        transitionSubtask(sub, 'rejected', { actor: 'human', reason: action.comment, refs: { sessionId: sub.sessionId } })
        transitionSubtask(sub, 'in-progress', { actor: 'system', reason: '批语已注入，重新排队执行（S5）' })
        sub.round += 1
        sub.attempt = 0
        sub.progressNotes = []
        sub.sessionId = undefined
      }
      task.round += 1
      if (task.status === 'review') {
        transitionTask(task, 'in-progress', { actor: 'human', reason: `打回：${firstLine(action.comment)}（T7）` })
      }
    })
    await this.pump()
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId, subtaskIds: selected }
  }

  private async actionApproveTask(action: Extract<TaskflowAction, { type: 'approveTask' }>): Promise<DispatchResult> {
    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      if (task.status !== 'review') throw new GuardError(`approveTask 仅允许 review 状态（当前 ${task.status}）`)
      if (!allSubtasksEvidencedOrDone(task)) throw new GuardError('T6 守卫：存在未提交证据或未决子任务')
      for (const sub of task.subtasks) {
        if (sub.status === 'review') {
          transitionSubtask(sub, 'done', {
            actor: 'human',
            reason: '任务级批准（§4.6 合并点击）',
            refs: { sessionId: sub.sessionId },
          })
        }
      }
      transitionTask(task, 'done', { actor: 'human', reason: '人工批准任务（T6）' })
    })
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  private async actionCancelTask(action: Extract<TaskflowAction, { type: 'cancelTask' }>): Promise<DispatchResult> {
    const cancels: string[] = []
    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      if (task.status === 'done' || task.status === 'cancelled' || task.status === 'archived') {
        throw new GuardError(`task ${action.taskId} 已是终态 ${task.status}，无法取消`)
      }
      for (const sub of task.subtasks) {
        if (sub.status === 'in-progress' && sub.sessionId !== undefined) cancels.push(sub.sessionId)
      }
      if (task.status === 'decomposing' && task.decomposeSessionIds.length > 0) {
        const last = task.decomposeSessionIds.at(-1)
        if (last !== undefined) cancels.push(last)
      }
      transitionTask(task, 'cancelled', { actor: 'human', reason: '人工取消（T9，二次确认）' })
    })
    for (const sessionId of cancels) {
      await this.adapter.cancelSession(sessionId).catch(() => undefined)
    }
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  private async actionArchiveTask(action: Extract<TaskflowAction, { type: 'archiveTask' }>): Promise<DispatchResult> {
    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      transitionTask(task, 'archived', { actor: 'human', reason: '归档（T10，只读）' })
    })
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  private async actionRetryBlocked(action: Extract<TaskflowAction, { type: 'retryBlocked' }>): Promise<DispatchResult> {
    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      if (action.subtaskId !== undefined) {
        const sub = findSubtask(task, action.subtaskId)
        if (sub === undefined) throw new GuardError(`subtask ${action.subtaskId} not found`)
        if (sub.status !== 'blocked') throw new GuardError(`subtask ${action.subtaskId} 状态为 ${sub.status}，仅 blocked 可重试`)
        sub.attempt = 0
        transitionSubtask(sub, 'pending', { actor: 'human', reason: '人工重试（S6 解除）' })
        if (task.status === 'blocked') {
          transitionTask(task, 'in-progress', { actor: 'human', reason: '人工解除阻塞，恢复实现' })
        } else if (task.status === 'ready') {
          transitionTask(task, 'in-progress', { actor: 'human', reason: '人工放行（T4）' })
        }
      } else {
        if (task.status !== 'blocked') throw new GuardError(`task ${action.taskId} 状态为 ${task.status}，仅 blocked 可重试`)
        if (task.subtasks.length === 0) {
          throw new GuardError('拆解尚未完成（T3′）：请使用 startDecompose 重试拆解，而非 retryBlocked')
        }
        for (const sub of task.subtasks) {
          if (sub.status === 'blocked') {
            sub.attempt = 0
            transitionSubtask(sub, 'pending', { actor: 'human', reason: '人工重试（S6 解除）' })
          }
        }
        if (allSubtasksEvidencedOrDone(task)) {
          transitionTask(task, 'review', { actor: 'human', reason: '恢复验收（解除迭代上限阻塞）' })
        } else {
          transitionTask(task, 'in-progress', { actor: 'human', reason: '人工解除阻塞，恢复实现' })
        }
      }
    })
    await this.pump()
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  private async actionRaiseMaxRounds(action: Extract<TaskflowAction, { type: 'raiseMaxRounds' }>): Promise<DispatchResult> {
    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      if (task.status === 'done' || task.status === 'cancelled' || task.status === 'archived') {
        throw new GuardError(`task ${action.taskId} 已是终态`)
      }
      task.maxRounds = action.maxRounds
      appendTaskNote(task, {
        actor: 'human',
        kind: 'max-rounds-raised',
        reason: `迭代上限调整为 ${action.maxRounds === null ? '不限' : action.maxRounds}`,
      })
    })
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  // —— 调度 ——

  /** 检查并启动就绪子任务（检查与置位在单次 mutate 内原子完成）。 */
  private async pump(): Promise<void> {
    const launches: PendingLaunch[] = []
    await this.store.mutate(ledger => {
      this.collectLaunches(ledger, launches)
    })
    await this.launchAll(launches)
  }

  private collectLaunches(ledger: Ledger, launches: PendingLaunch[]): void {
    let running = 0
    for (const task of ledger.tasks) {
      for (const sub of task.subtasks) {
        if (sub.status === 'in-progress' && sub.sessionId !== undefined) running += 1
      }
    }
    for (const task of ledger.tasks) {
      if (task.status !== 'in-progress') continue
      if (this.needsPermissionConfirm(task.contract.pins.permission) && !task.permissionConfirmed) {
        const alreadyNoted = task.events.some(e => e.kind === 'awaiting-permission-confirm')
        if (!alreadyNoted) {
          appendTaskNote(task, {
            actor: 'system',
            kind: 'awaiting-permission-confirm',
            reason: `执行权限 ${task.contract.pins.permission} 高于会话默认 ${this.config.sessionDefaultPermission}，等待人工确认（§7.1）`,
          })
        }
        continue
      }
      for (const sub of task.subtasks) {
        if (running >= this.config.maxConcurrentSubtasks) return
        // 排队态：pending，或打回/重启后的 in-progress 且尚未取号
        const queued = sub.status === 'pending' || (sub.status === 'in-progress' && sub.sessionId === undefined)
        if (!queued) continue
        if (this.config.enforceDeps && !this.depsSatisfied(task, sub)) continue
        if (sub.attempt >= this.config.maxSessionAttempts) {
          // §8：重试耗尽 → S6 blocked + T8
          transitionSubtask(sub, 'blocked', { actor: 'system', reason: `会话重试耗尽（attempt ${sub.attempt}/${this.config.maxSessionAttempts}）` })
          if (task.status === 'in-progress') {
            transitionTask(task, 'blocked', { actor: 'system', reason: `子任务 ${sub.id} 重试耗尽（T8）` })
          }
          continue
        }
        const sessionId = `tfs_${sub.id}_r${sub.round}a${sub.attempt + 1}_${randomId(4)}`
        sub.sessionId = sessionId
        sub.sessionIds.push(sessionId)
        sub.attempt += 1
        sub.progressNotes = []
        if (sub.status === 'pending') {
          transitionSubtask(sub, 'in-progress', { actor: 'system', reason: '调度器启动执行会话（S2）', refs: { sessionId } })
        } else {
          appendSubtaskNote(sub, { actor: 'system', kind: 'session-started', reason: `重启执行会话 attempt ${sub.attempt}`, refs: { sessionId } })
        }
        launches.push({ taskId: task.id, subtaskId: sub.id, sessionId })
        running += 1
      }
    }
  }

  /** M1 忽略 deps（Q2 裁决：仅展示）；enforceDeps=true 时启用 DAG 就绪守卫。 */
  private depsSatisfied(task: Task, sub: Subtask): boolean {
    return sub.deps.every(dep => {
      const target = task.subtasks.find(s => s.id === dep)
      return target === undefined ? false : target.status === 'done'
    })
  }

  private async launchAll(launches: PendingLaunch[]): Promise<void> {
    for (const launch of launches) {
      void this.runSubtaskSession(launch).catch(() => undefined)
    }
  }

  private async runSubtaskSession(launch: PendingLaunch): Promise<void> {
    if (this.disposed) return
    const snapshot = this.store.snapshot()
    const task = snapshot.tasks.find(t => t.id === launch.taskId)
    const sub = task?.subtasks.find(s => s.id === launch.subtaskId)
    if (task === undefined || sub === undefined || sub.sessionId !== launch.sessionId) return
    const input = this.buildExecutionInput(task, sub, launch.sessionId)
    if (input === null) return
    let outcome: ExecutionOutcome
    try {
      outcome = await this.adapter.runExecutionSession(input)
    } catch (error) {
      outcome = { kind: 'crashed', error: errorMessage(error) }
    }
    if (this.disposed) return
    await this.handleExecutionOutcome(launch.taskId, launch.subtaskId, launch.sessionId, outcome)
  }

  private buildExecutionInput(task: Task, sub: Subtask, sessionId: string): ExecutionSessionInput | null {
    return {
      taskId: task.id,
      subtaskId: sub.id,
      sessionId,
      round: sub.round,
      attempt: sub.attempt,
      prompt: renderExecutionPrompt(task, sub),
      workspace: task.contract.pins.workspace,
      presetId: task.contract.pins.presetId,
      permission: task.contract.pins.permission,
      tools: {
        submitEvidence: async payload => this.toolSubmitEvidence(sessionId, payload),
        reportBlocker: async reason => this.toolReportBlocker(sessionId, reason),
        updateProgress: async note => this.toolUpdateProgress(sessionId, note),
      },
    }
  }

  private async handleExecutionOutcome(
    taskId: string,
    subtaskId: string,
    sessionId: string,
    outcome: ExecutionOutcome,
  ): Promise<void> {
    await this.store.mutate(ledger => {
      const task = findTask(ledger, taskId)
      const sub = task === null ? undefined : findSubtask(task, subtaskId)
      if (task === null || sub === undefined) return
      if (task.status === 'cancelled' || task.status === 'archived') return
      if (sub.sessionId !== sessionId) return // 已被新轮次/重启取代
      if (sub.status !== 'in-progress') return // review（证据已受理）/ blocked / done：无需处理

      // 会话结束但证据未受理：回到排队态（attempt 上限由调度器判定）
      const reason = outcome.kind === 'completed' ? '会话结束但未提交有效证据' : `会话崩溃：${outcome.error}`
      appendSubtaskNote(sub, {
        actor: 'system',
        kind: outcome.kind === 'completed' ? 'session-ended-no-evidence' : 'session-crashed',
        reason,
        refs: { sessionId },
      })
      sub.sessionId = undefined
    })
    await this.pump()
  }

  // —— agent 工具面（Host 权威，仅对 taskflow 会话暴露）——

  private async toolSubmitEvidence(
    sessionId: string,
    payload: unknown,
  ): Promise<{ accepted: true } | { accepted: false; correction: string }> {
    let parsed
    try {
      parsed = parseEvidenceInput(payload)
    } catch (error) {
      if (error instanceof EvidenceRejectedError) {
        return { accepted: false, correction: renderEvidenceCorrection(error) }
      }
      return { accepted: false, correction: 'evidence payload malformed.' }
    }
    try {
      await this.store.mutate(ledger => {
        const found = findBySession(ledger, sessionId)
        if (found === null) throw new GuardError(`会话 ${sessionId} 不对应任何执行中的子任务`)
        const { task, sub } = found
        if (task.status === 'cancelled' || task.status === 'archived') {
          throw new GuardError('任务已取消/归档，证据不再受理')
        }
        if (sub.status !== 'in-progress' || sub.sessionId !== sessionId) {
          throw new GuardError(`子任务 ${sub.id} 当前状态 ${sub.status}，不接受该会话的证据`)
        }
        const normalized = normalizeEvidence(parsed, sub.acceptance.map(a => a.id))
        const evidence: Evidence = {
          submittedAt: Date.now(),
          changesSummary: normalized.changesSummary,
          verification: normalized.verification,
          selfCheck: normalized.selfCheck,
          refs: { sessionId, ...(normalized.diffSummary === undefined ? {} : { diffSummary: normalized.diffSummary }) },
        }
        sub.evidence = evidence
        sub.evidenceHistory.push({
          round: sub.round,
          submittedAt: evidence.submittedAt,
          sessionId,
          allPassed: evidence.selfCheck.every(c => c.verdict === 'pass') && evidence.verification.every(v => v.passed),
          changesSummary: evidence.changesSummary,
        })
        if (sub.evidenceHistory.length > MAX_EVIDENCE_HISTORY) {
          sub.evidenceHistory.splice(0, sub.evidenceHistory.length - MAX_EVIDENCE_HISTORY)
        }
        appendSubtaskNote(sub, {
          actor: 'ai',
          kind: 'evidence-submitted',
          reason: `证据提交：自检 ${evidence.selfCheck.filter(c => c.verdict === 'pass').length}/${evidence.selfCheck.length} 通过`,
          refs: { sessionId },
        })
        transitionSubtask(sub, 'review', { actor: 'ai', reason: '证据三要素齐全，进入待验收（S3）', refs: { sessionId } })
        if (allSubtasksEvidencedOrDone(task) && task.status === 'in-progress') {
          transitionTask(task, 'review', { actor: 'system', reason: '全部子任务证据齐全/已批准，待人工终批（T5）' })
        }
      })
      return { accepted: true }
    } catch (error) {
      if (error instanceof EvidenceRejectedError) {
        return { accepted: false, correction: renderEvidenceCorrection(error) }
      }
      return { accepted: false, correction: `证据提交被拒：${errorMessage(error)}` }
    }
  }

  private async toolReportBlocker(sessionId: string, reason: string): Promise<{ accepted: boolean }> {
    try {
      await this.store.mutate(ledger => {
        const found = findBySession(ledger, sessionId)
        if (found === null) return
        const { task, sub } = found
        if (sub.status !== 'in-progress' || sub.sessionId !== sessionId) return
        appendSubtaskNote(sub, { actor: 'ai', kind: 'blocker-reported', reason: `agent 报障：${reason}`, refs: { sessionId } })
        transitionSubtask(sub, 'blocked', { actor: 'ai', reason: `agent 报障：${reason}`, refs: { sessionId } })
        if (task.status === 'in-progress') {
          transitionTask(task, 'blocked', { actor: 'system', reason: `子任务 ${sub.id} 报障（T8）` })
        }
      })
      return { accepted: true }
    } catch {
      return { accepted: false }
    }
  }

  private async toolUpdateProgress(sessionId: string, note: string): Promise<{ accepted: boolean }> {
    try {
      await this.store.mutate(ledger => {
        const found = findBySession(ledger, sessionId)
        if (found === null) return
        const { sub } = found
        if (sub.sessionId !== sessionId || sub.status !== 'in-progress') return
        const clipped = note.slice(0, 500)
        sub.progressNotes.push(clipped)
        appendSubtaskNote(sub, { actor: 'ai', kind: 'progress', reason: clipped, refs: { sessionId } })
      })
      return { accepted: true }
    } catch {
      return { accepted: false }
    }
  }

  // —— 杂项 ——

  private needsPermissionConfirm(permission: string): boolean {
    return permission !== this.config.sessionDefaultPermission
  }

  private findTask(taskId: string): Task | null {
    return findTask(this.store.snapshot(), taskId)
  }

  private currentRevision(): number {
    return this.store.snapshot().revision
  }

  /** 静默容错的受控变更（恢复路径）。 */
  private async mutateQuiet(fn: (ledger: Ledger) => void): Promise<void> {
    await this.store.mutate(fn).catch(() => undefined)
  }
}

// —— 模块级查找工具 ——

function findTask(ledger: Ledger, taskId: string): Task | null {
  return ledger.tasks.find(t => t.id === taskId) ?? null
}

function findSubtask(task: Task, subtaskId: string): Subtask | undefined {
  return task.subtasks.find(s => s.id === subtaskId)
}

function findBySession(ledger: Ledger, sessionId: string): { task: Task; sub: Subtask } | null {
  for (const task of ledger.tasks) {
    for (const sub of task.subtasks) {
      if (sub.sessionId === sessionId) return { task, sub }
    }
  }
  return null
}

/** 打回默认作用域：自检/验证含瑕疵的优先；否则全部 review 态（§4.6）。 */
function defaultRejectScope(inReview: Subtask[]): string[] {
  const imperfect = inReview.filter(
    sub => sub.evidence === undefined
      || sub.evidence.selfCheck.some(c => c.verdict !== 'pass')
      || sub.evidence.verification.some(v => !v.passed),
  )
  return (imperfect.length > 0 ? imperfect : inReview).map(sub => sub.id)
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
