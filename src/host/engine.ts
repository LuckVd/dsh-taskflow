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
import type { ApprovalRecord, DispatchResult, EngineState, Evidence, ExecutionMode, Ledger, ModelSettings, Pins, SessionModelSelection, Subtask, Task } from '../protocol/types.ts'
import { resolveExecutionMode } from '../protocol/types.ts'
import { LedgerStore, LedgerWriteError } from './ledger.ts'
import { modelLabel } from './settings.ts'
import { renderDecomposePrompt, renderExecutionPrompt, renderFinalCheckPrompt, renderTriagePrompt } from './prompts.ts'
import {
  IllegalTransitionError,
  allSubtasksEvidencedOrDone,
  isTaskTerminal,
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
  /** 拆解模型选择（全局设置；null = 适配器回退宿主默认）。 */
  model: SessionModelSelection | null
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
  /** 执行模型选择（全局设置；null = 适配器回退宿主默认）。 */
  model: SessionModelSelection | null
  /** 执行模式（§7.1b）：适配器据此决定是否注册 approval/request 应答方及其策略。 */
  executionMode: ExecutionMode
  /** Host 权威工具面：校验与落库都在引擎内完成（不变量 1/3）。 */
  tools: AgentToolSurface
  /** 审批桥：approval 模式下应答方收到提权请求时调用；Promise 由人在看板裁决后 resolve。 */
  approvals: ApprovalBridge
}

/** 审批桥（引擎实现，适配器消费）：approval/request → 落库 + 看板裁决。 */
export interface ApprovalBridge {
  request(input: { sessionId: string; toolName: string; reason?: string }): Promise<'allowed' | 'rejected'>
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

/** 任务级终检会话输入（会话形制与拆解相同：JSON 文本输出；2026-09-11 语义升级）。 */
export type FinalCheckSessionInput = DecomposeSessionInput
/** 打回定位（triage）会话输入（同拆解形制）。 */
export type TriageSessionInput = DecomposeSessionInput

export interface SessionAdapter {
  readonly kind: string
  runDecomposeSession(input: DecomposeSessionInput): Promise<DecomposeResult>
  runExecutionSession(input: ExecutionSessionInput): Promise<ExecutionOutcome>
  /**
   * 可选：任务级终检会话（§4.5，2026-09-11 语义升级）。全部子任务完成后、人工终批前，
   * 对照「任务级验收标准」核验整体交付并产出任务级证据卡。不支持 = 引擎兜底直接 T5
   * （子任务证据作为验收材料）。
   */
  runFinalCheckSession?(input: FinalCheckSessionInput): Promise<DecomposeResult>
  /**
   * 可选：打回定位会话（§4.6，2026-09-11 语义升级）。把人类批语映射到需返工的子任务集合，
   * 未选中的不重跑。不支持 = 打回时全量返工（旧语义兜底）。
   */
  runTriageSession?(input: TriageSessionInput): Promise<DecomposeResult>
  /** 重启恢复查询：该会话是否有持久记录（§4.4 确定性恢复）。 */
  hasSessionRecord(sessionId: string): Promise<boolean>
  /** 尽力而为终止运行中会话（T9）。 */
  cancelSession(sessionId: string): Promise<void>
  /** 可选：重启后接管既有会话（re-attach 并等待结果）。 */
  adoptSession?(input: ExecutionSessionInput): Promise<ExecutionOutcome>
  /** 可选：把运行中会话的权限预设原地提升（decideApproval「完全放行」）。false = 提升失败（留痕，会话可能再次发起审批）。 */
  elevateSession?(sessionId: string, preset: string): Promise<boolean>
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
  /** 任务级终检会话自动重试次数（§4.5，2026-09-11：失败重试 1 次，再失败兜底直接 T5）。 */
  finalizeRetries: number
  /** M1 忽略 deps（仅展示）；true 时启用 DAG 就绪守卫（M2，Q2 裁决）。 */
  enforceDeps: boolean
  /**
   * 执行会话静默看门狗（分钟；0 = 关闭）：会话无 pending 审批而静默超过该时长
   * → 子任务转 blocked（留痕）+ 取消会话。等审批不算停滞（审批可见，有通知）。
   */
  sessionStallTimeoutMin: number
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxConcurrentSubtasks: 1,
  sessionDefaultPermission: 'read-only',
  maxSessionAttempts: 2,
  decomposeRetries: 1,
  finalizeRetries: 1,
  enforceDeps: false,
  sessionStallTimeoutMin: 30,
}

/**
 * 迭代上限默认值：不限（null）。任务应一直跑到人工验收为止——
 * 上限只是可选防失控开关（创建时可显式设置 [1,99]），默认不再中途拦人。
 */
export const DEFAULT_MAX_ROUNDS: number | null = null
/** 每子任务保留的证据历史条数（NFR-05 有界）。 */
const MAX_EVIDENCE_HISTORY = 20
/** 每任务保留的审批记录条数（NFR-05 有界；优先淘汰已裁决条目）。 */
const MAX_APPROVALS = 50

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
  /** 终检会话当前 attempt（按任务记；用于失败自动重试判定）。 */
  private readonly finalizeAttempts = new Map<string, number>()
  /**
   * 进程内仍存活的执行会话（launch → 适配器收敛为止）。证据提交后子任务状态已是
   * review，但会话本体仍在收尾——调度器必须把它算进 WIP 额度，否则「全局串行」
   * 会被打破（2026-09-11 并发回归发现）。内存态：重启后由 boot 的恢复逻辑收敛。
   */
  private readonly liveExecutionSessions = new Set<string>()
  /** 待裁决审批：approvalId → resolver（人在看板裁决后 resolve，适配器应答方 await 它）。 */
  private readonly pendingApprovals = new Map<string, (decision: 'allowed' | 'rejected') => void>()
  /** 执行会话静默看门狗：sessionId → timer。 */
  private readonly stallTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 全局模型设置（内存权威；持久化由 ModelSettingsStore 承担，HTTP 层经 setModelSettings 写入）。 */
  private modelSettings: ModelSettings = { decompose: null, execution: null }
  private disposed = false
  private booted = false

  constructor(
    private readonly store: LedgerStore,
    private readonly adapter: SessionAdapter,
    readonly config: EngineConfig = DEFAULT_ENGINE_CONFIG,
  ) {}

  /** 全局模型设置（快照）。 */
  getModelSettings(): ModelSettings {
    return structuredClone(this.modelSettings)
  }

  /** 覆盖全局模型设置（调用方负责持久化；仅影响之后新建的会话）。 */
  setModelSettings(next: ModelSettings): void {
    this.modelSettings = {
      decompose: next.decompose === null ? null : { ...next.decompose },
      execution: next.execution === null ? null : { ...next.execution },
    }
  }

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
    // 孤儿会话清理：终态任务（done/cancelled/archived）的残留 in-progress 子任务
    // 一律收敛（幂等、留痕）。不清理的话它们的 sessionId 会永久占满 WIP 额度，
    // 使调度器对所有新任务静默失效（真机 2026-09-10 事故：取消后无法再开工）。
    const needsFinalCheck: string[] = []
    await this.mutateQuiet(ledger => {
      for (const task of ledger.tasks) {
        if (!isTaskTerminal(task.status)) {
          // 终检/打回定位是轻会话，不跨重启接管：清除标记；全部证据齐备的任务随后重跑终检。
          if (task.finalizeSessionId !== undefined || task.triageSessionId !== undefined) {
            appendTaskNote(task, {
              actor: 'system',
              kind: 'boot-session-recovered',
              reason: '启动恢复：终检/打回定位会话不跨重启，标记已收敛',
            })
            task.finalizeSessionId = undefined
            task.triageSessionId = undefined
          }
          if (task.status === 'in-progress' && allSubtasksEvidencedOrDone(task) && task.evidence === undefined) {
            needsFinalCheck.push(task.id)
          }
        }
        for (const sub of task.subtasks) {
          if (sub.status !== 'in-progress' || sub.sessionId === undefined) continue
          if (!isTaskTerminal(task.status)) continue
          sub.sessionId = undefined
          sub.attempt = 0
          transitionSubtask(sub, 'blocked', { actor: 'system', reason: '启动恢复：任务已终态，清理残留运行标记' })
        }
      }
    })
    for (const taskId of needsFinalCheck) {
      await this.startFinalCheckInternal(taskId, 1)
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
    for (const timer of this.stallTimers.values()) clearTimeout(timer)
    this.stallTimers.clear()
    for (const [id, resolver] of this.pendingApprovals) {
      this.pendingApprovals.delete(id)
      resolver('rejected')
    }
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
    // 原进程的待裁决审批随进程消失：先置 expired（新进程的应答方会重新转发真实的审批）
    await this.expireApprovals(sessionId, '重启恢复：原会话审批失效')
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
    this.armStallTimer(sessionId, taskId, subtaskId)
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
        case 'decideApproval':
          return await this.actionDecideApproval(action)
        case 'generateTaskEvidence':
          return await this.actionGenerateTaskEvidence(action)
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
      const pins: Pins = {
        workspace: action.pins?.workspace ?? '',
        presetId: action.pins?.presetId ?? null,
        permission: action.pins?.permission ?? this.config.sessionDefaultPermission,
        ...(action.pins?.executionMode !== undefined ? { executionMode: action.pins.executionMode } : {}),
      }
      const task: Task = {
        id: taskId,
        title: action.title,
        description: action.description,
        contract: {
          objective: action.objective ?? action.title,
          acceptance,
          // 留空 = 拆解时 AI 补全（ai-drafted 为待补状态标记）
          sourceOfAcceptance: acceptance.length > 0 ? 'human' : 'ai-drafted',
          pins,
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
        permissionConfirmed: !this.needsPermissionConfirm(pins),
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
      const model = this.modelSettings.decompose
      const modelRefs = { sessionId, ...(modelLabel(model) !== undefined ? { model: modelLabel(model) } : {}) }
      if (task.status === 'decomposing') {
        // 重试路径：已在拆解中，不重复 T2，仅追加会话与留痕
        appendTaskNote(task, { actor: 'system', kind: 'decompose-retry', reason: `拆解重试 attempt ${attempt}`, refs: modelRefs })
      } else {
        transitionTask(task, 'decomposing', {
          actor: task.status === 'draft' ? 'human' : 'system',
          reason: task.status === 'draft' ? '开始拆解（T2）' : `重新拆解 attempt ${attempt}`,
          refs: modelRefs,
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
        model,
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
      if (task.status !== 'draft' && task.status !== 'ready' && task.status !== 'blocked') {
        throw new GuardError(`updateContract 仅允许 draft/ready/blocked 状态（当前 ${task.status}）`)
      }
      if (task.status === 'blocked' && (action.objective !== undefined || action.acceptance !== undefined || action.autoStart !== undefined)) {
        // 受阻任务只放行 pins 修正（权限签错救得回来），合同实体仍须走打回迭代（§4.2）
        throw new GuardError('blocked 状态仅允许修改 pins（workspace/presetId/permission/executionMode）')
      }
      if (action.objective !== undefined) task.contract.objective = action.objective
      if (action.acceptance !== undefined) {
        task.contract.acceptance = materializeAcceptance(action.acceptance, task.contract.acceptance)
        task.contract.sourceOfAcceptance = 'human'
        delete task.contract.originalHumanAcceptance
      }
      if (action.pins !== undefined) {
        let pinsChanged = false
        if (action.pins.workspace !== undefined) { task.contract.pins.workspace = action.pins.workspace; pinsChanged = true }
        if (action.pins.presetId !== undefined) { task.contract.pins.presetId = action.pins.presetId; pinsChanged = true }
        if (action.pins.permission !== undefined && action.pins.permission !== task.contract.pins.permission) {
          task.contract.pins.permission = action.pins.permission
          pinsChanged = true
        }
        if (action.pins.executionMode !== undefined && action.pins.executionMode !== task.contract.pins.executionMode) {
          task.contract.pins.executionMode = action.pins.executionMode
          pinsChanged = true
        }
        if (pinsChanged) {
          // §7.1：pins 变更后确认状态重置（re-arm）；auto 档（完全权限）天然免确认
          task.permissionConfirmed = !this.needsPermissionConfirm(task.contract.pins)
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
      if (this.needsPermissionConfirm(task.contract.pins)) {
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
    let needsFinalCheck = false
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
      // T5 延后：全部证据齐备后先跑任务级终检（§4.5），完成（或兜底）才进 review
      if (allSubtasksEvidencedOrDone(task) && task.status === 'in-progress') {
        needsFinalCheck = true
      }
    })
    if (needsFinalCheck) await this.startFinalCheckInternal(action.taskId, 1)
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId, subtaskIds: [action.subtaskId] }
  }

  private async actionRejectSubtask(action: Extract<TaskflowAction, { type: 'rejectSubtask' }>): Promise<DispatchResult> {
    const taskNow = this.findTask(action.taskId)
    if (taskNow === null) return { ok: false, code: 'not-found', error: `task ${action.taskId} not found` }
    if (taskNow.status !== 'in-progress' && taskNow.status !== 'review') {
      return { ok: false, code: 'guard', error: `rejectSubtask 仅允许 in-progress/review 任务（当前 ${taskNow.status}）` }
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

    // 显式指定范围（API 高级路径）：立即按 S5 执行
    if (action.subtaskIds !== undefined) {
      const selected = action.subtaskIds
      if (selected.length === 0) {
        return { ok: false, code: 'guard', error: '没有可打回的子任务（须处于待验收状态）' }
      }
      await this.store.mutate(ledger => {
        const task = findTask(ledger, action.taskId)
        if (task === null) throw new GuardError(`task ${action.taskId} not found`)
        for (const subtaskId of selected) {
          reworkSubtaskInPlace(task, subtaskId, action.comment)
        }
        task.round += 1
        invalidateTaskEvidence(task)
        if (task.status === 'review') {
          transitionTask(task, 'in-progress', { actor: 'human', reason: `打回：${firstLine(action.comment)}（T7）` })
        }
      })
      await this.pump()
      return { ok: true, revision: this.currentRevision(), taskId: action.taskId, subtaskIds: selected }
    }

    // 默认路径（2026-09-11 语义）：人只打回任务并给批语，返工范围由 AI triage 定位；
    // 适配器不支持定位会话 → 全量兜底（旧语义，立即同步执行）。
    if (this.adapter.runTriageSession === undefined) {
      const inReview = taskNow.subtasks.filter(s => s.status === 'review')
      if (inReview.length === 0) {
        return { ok: false, code: 'guard', error: '没有可打回的子任务（须处于待验收状态）' }
      }
      const scope = defaultRejectScope(inReview)
      await this.store.mutate(ledger => {
        const task = findTask(ledger, action.taskId)
        if (task === null) throw new GuardError(`task ${action.taskId} not found`)
        for (const subtaskId of scope) {
          reworkSubtaskInPlace(task, subtaskId, action.comment)
        }
        task.round += 1
        invalidateTaskEvidence(task)
        if (task.status === 'review') {
          transitionTask(task, 'in-progress', { actor: 'human', reason: `打回：${firstLine(action.comment)}（T7）` })
        }
        appendTaskNote(task, {
          actor: 'system',
          kind: 'rework-scope',
          reason: `返工范围（适配器无定位能力，全量兜底）：${scope.join(', ')}`,
        })
      })
      await this.pump()
      return { ok: true, revision: this.currentRevision(), taskId: action.taskId, subtaskIds: scope }
    }

    if (taskNow.triageSessionId !== undefined) {
      return { ok: false, code: 'guard', error: '已有打回定位会话进行中，请稍候' }
    }
    const inReviewCount = taskNow.subtasks.filter(s => s.status === 'review').length
    if (inReviewCount === 0) {
      return { ok: false, code: 'guard', error: '没有可打回的子任务（须处于待验收状态）' }
    }
    const { result: input } = await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      const sessionId = `tfs_${task.id}_t1_${randomId(4)}`
      task.triageSessionId = sessionId
      appendTaskNote(task, {
        actor: 'human',
        kind: 'reject',
        reason: `打回批语：${firstLine(action.comment)}（AI 定位返工范围中）`,
      })
      if (task.status === 'review') {
        transitionTask(task, 'in-progress', { actor: 'human', reason: `打回：${firstLine(action.comment)}（T7）` })
      }
      const model = this.modelSettings.decompose
      return {
        taskId: task.id,
        sessionId,
        prompt: renderTriagePrompt(task, action.comment),
        workspace: task.contract.pins.workspace,
        presetId: task.contract.pins.presetId,
        permission: task.contract.pins.permission,
        model,
      }
    })
    void this.runTriage(input, action.comment).catch(() => undefined)
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId, subtaskIds: [] }
  }

  // —— 任务级终检（§4.5，2026-09-11 语义升级）——

  /**
   * 全部子任务证据齐备后、人工终批（T5）前，跑一次终检会话产出任务级证据卡。
   * 适配器不支持终检 → 直接 T5 兜底（子任务证据即验收材料）。
   */
  private async startFinalCheckInternal(taskId: string, attempt: number): Promise<void> {
    if (this.adapter.runFinalCheckSession === undefined) {
      await this.mutateQuiet(ledger => {
        const task = findTask(ledger, taskId)
        if (task === null || task.status !== 'in-progress') return
        if (!allSubtasksEvidencedOrDone(task)) return
        transitionTask(task, 'review', { actor: 'system', reason: '全部子任务证据齐全/已批准，待人工终批（T5，无终检兜底）' })
      })
      return
    }
    const { result: input } = await this.store.mutate(ledger => {
      const task = findTask(ledger, taskId)
      if (task === null) throw new GuardError(`task ${taskId} not found`)
      if (task.status !== 'in-progress' || !allSubtasksEvidencedOrDone(task)) return null
      if (task.evidence !== undefined || task.finalizeSessionId !== undefined) return null
      const sessionId = `tfs_${taskId}_f${attempt}_${randomId(4)}`
      task.finalizeSessionId = sessionId
      const model = this.modelSettings.decompose
      const modelRefs = { sessionId, ...(modelLabel(model) !== undefined ? { model: modelLabel(model) } : {}) }
      appendTaskNote(task, {
        actor: 'system',
        kind: 'final-check-started',
        reason: `AI 终检开始（attempt ${attempt}）：对照任务级验收标准核验整体交付`,
        refs: modelRefs,
      })
      return {
        taskId: task.id,
        sessionId,
        prompt: renderFinalCheckPrompt(task),
        workspace: task.contract.pins.workspace,
        presetId: task.contract.pins.presetId,
        permission: task.contract.pins.permission,
        model,
      }
    })
    if (input === null) return
    this.finalizeAttempts.set(taskId, attempt)
    void this.runFinalCheck(input).catch(() => undefined)
  }

  private async runFinalCheck(input: FinalCheckSessionInput): Promise<void> {
    if (this.disposed || this.adapter.runFinalCheckSession === undefined) return
    const run = this.adapter.runFinalCheckSession?.bind(this.adapter) as ((i: FinalCheckSessionInput) => Promise<DecomposeResult>) | undefined
    if (run === undefined) return
    let result: DecomposeResult
    try {
      result = await run(input)
    } catch (error) {
      result = { kind: 'failed', error: errorMessage(error) }
    }
    if (this.disposed) return

    if (result.kind === 'ok') {
      try {
        const parsed = parseEvidenceInput(result.output)
        await this.handleFinalCheckSuccess(input.taskId, input.sessionId, parsed)
        return
      } catch (error) {
        const message = error instanceof EvidenceRejectedError ? renderEvidenceCorrection(error) : errorMessage(error)
        await this.handleFinalCheckFailure(input.taskId, input.sessionId, message)
        return
      }
    }
    await this.handleFinalCheckFailure(input.taskId, input.sessionId, result.error)
  }

  private async handleFinalCheckSuccess(
    taskId: string,
    sessionId: string,
    parsed: ReturnType<typeof parseEvidenceInput>,
  ): Promise<void> {
    // 规范化（对照任务级验收标准逐条等长）在快照上先做：失败 → 走失败重试/兜底路径
    const snapshot = this.store.snapshot()
    const current = snapshot.tasks.find(t => t.id === taskId)
    if (current === undefined) return
    const normalized = normalizeEvidence(parsed, current.contract.acceptance.map(a => a.id))
    const evidence: Evidence = {
      submittedAt: Date.now(),
      changesSummary: normalized.changesSummary,
      verification: normalized.verification,
      selfCheck: normalized.selfCheck,
      refs: { sessionId, ...(normalized.diffSummary === undefined ? {} : { diffSummary: normalized.diffSummary }) },
    }
    await this.store.mutate(ledger => {
      const task = findTask(ledger, taskId)
      if (task === null || task.finalizeSessionId !== sessionId) return // 已被新 attempt / 重启 / 返工取代
      if (!allSubtasksEvidencedOrDone(task)) {
        // 终检期间任务被打回重新迭代：本份证据已过时，作废
        task.finalizeSessionId = undefined
        appendTaskNote(task, { actor: 'system', kind: 'final-check-discarded', reason: '终检完成但任务已重新进入迭代，本份证据作废' })
        return
      }
      task.evidence = evidence
      task.finalizeSessionId = undefined
      const passed = evidence.selfCheck.filter(c => c.verdict === 'pass').length
      appendTaskNote(task, {
        actor: 'ai',
        kind: 'task-evidence-submitted',
        reason: `任务级终检：自检 ${passed}/${evidence.selfCheck.length} 通过`,
        refs: { sessionId },
      })
      if (task.status === 'in-progress') {
        transitionTask(task, 'review', { actor: 'system', reason: '终检完成：任务级证据已产出，待人工终批（T5）' })
      }
    })
  }

  private async handleFinalCheckFailure(taskId: string, sessionId: string, reason: string): Promise<void> {
    const attempt = this.finalizeAttempts.get(taskId) ?? 1
    if (attempt <= this.config.finalizeRetries) {
      await this.mutateQuiet(ledger => {
        const task = findTask(ledger, taskId)
        if (task === null || task.finalizeSessionId !== sessionId) return
        task.finalizeSessionId = undefined
        appendTaskNote(task, {
          actor: 'system',
          kind: 'final-check-retry',
          reason: `终检失败（${firstLine(reason)}），自动重试`,
          refs: { sessionId },
        })
      })
      await this.startFinalCheckInternal(taskId, attempt + 1)
      return
    }
    await this.mutateQuiet(ledger => {
      const task = findTask(ledger, taskId)
      if (task === null || task.finalizeSessionId !== sessionId) return
      task.finalizeSessionId = undefined
      appendTaskNote(task, {
        actor: 'system',
        kind: 'final-check-fallback',
        reason: `终检失败（${firstLine(reason)}）；无任务级证据进入待验收，子任务证据作为验收材料（T5 兜底）`,
        refs: { sessionId },
      })
      if (task.status === 'in-progress' && allSubtasksEvidencedOrDone(task)) {
        transitionTask(task, 'review', { actor: 'system', reason: '全部子任务证据齐全/已批准，待人工终批（T5，终检兜底）' })
      }
    })
  }

  /** 手动补跑终检（存量任务进 review 时无任务级证据；完成后任务停留在 review）。 */
  private async actionGenerateTaskEvidence(action: Extract<TaskflowAction, { type: 'generateTaskEvidence' }>): Promise<DispatchResult> {
    const task = this.findTask(action.taskId)
    if (task === null) return { ok: false, code: 'not-found', error: `task ${action.taskId} not found` }
    if (task.status !== 'review') {
      return { ok: false, code: 'guard', error: `generateTaskEvidence 仅允许 review 状态（当前 ${task.status}）` }
    }
    if (!allSubtasksEvidencedOrDone(task)) {
      return { ok: false, code: 'guard', error: '存在未提交证据或未决子任务，无需终检' }
    }
    if (task.finalizeSessionId !== undefined) {
      return { ok: false, code: 'guard', error: '终检已在进行中' }
    }
    if (this.adapter.runFinalCheckSession === undefined) {
      return { ok: false, code: 'guard', error: '当前适配器不支持任务级终检' }
    }
    const { result: input } = await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null || task.status !== 'review' || task.evidence !== undefined || task.finalizeSessionId !== undefined) {
        return null
      }
      const sessionId = `tfs_${task.id}_f1_${randomId(4)}`
      task.finalizeSessionId = sessionId
      const model = this.modelSettings.decompose
      appendTaskNote(task, {
        actor: 'human',
        kind: 'final-check-started',
        reason: '人工触发补跑任务级终检',
        refs: { sessionId, ...(modelLabel(model) !== undefined ? { model: modelLabel(model) } : {}) },
      })
      return {
        taskId: task.id,
        sessionId,
        prompt: renderFinalCheckPrompt(task),
        workspace: task.contract.pins.workspace,
        presetId: task.contract.pins.presetId,
        permission: task.contract.pins.permission,
        model,
      }
    })
    if (input === null) return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
    this.finalizeAttempts.set(action.taskId, 1)
    void this.runFinalCheck(input).catch(() => undefined)
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  // —— 打回定位（triage，§4.6 2026-09-11 语义）——

  private async runTriage(input: TriageSessionInput, comment: string): Promise<void> {
    if (this.disposed || this.adapter.runTriageSession === undefined) return
    const run = this.adapter.runTriageSession?.bind(this.adapter) as ((i: TriageSessionInput) => Promise<DecomposeResult>) | undefined
    if (run === undefined) return
    let result: DecomposeResult
    try {
      result = await run(input)
    } catch (error) {
      result = { kind: 'failed', error: errorMessage(error) }
    }
    if (this.disposed) return

    // 解析定位结果：非法/为空/全部不可识别 → 全量兜底
    let scope: string[] | null = null
    let note = ''
    if (result.kind === 'ok' && typeof result.output === 'object' && result.output !== null) {
      const parsed = result.output as { reworkSubtaskIds?: unknown; note?: unknown }
      if (Array.isArray(parsed.reworkSubtaskIds)) {
        const requested = parsed.reworkSubtaskIds.filter((id): id is string => typeof id === 'string')
        const reviewIds = new Set(
          (this.findTask(input.taskId)?.subtasks ?? []).filter(s => s.status === 'review').map(s => s.id),
        )
        const known = requested.filter(id => reviewIds.has(id))
        if (known.length > 0) {
          scope = known
          note = typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : ''
        }
      }
    }

    try {
      await this.store.mutate(ledger => {
        const task = findTask(ledger, input.taskId)
        if (task === null) throw new GuardError(`task ${input.taskId} not found`)
        if (task.triageSessionId !== input.sessionId) return // 已被新打回/取消取代
        if (scope === null) {
          scope = task.subtasks.filter(s => s.status === 'review').map(s => s.id)
          note = result.kind === 'failed' ? `定位会话失败（${firstLine(result.error)}），全量兜底` : '定位结果无效，全量兜底'
        }
        if (scope.length === 0) {
          // 定位期间状态已变化（无可打回项）：仅收敛标记
          task.triageSessionId = undefined
          appendTaskNote(task, { actor: 'system', kind: 'rework-scope', reason: '定位完成但已无可打回子任务，收敛' })
          return
        }
        for (const subtaskId of scope) {
          const sub = findSubtask(task, subtaskId)
          if (sub === undefined || sub.status !== 'review') continue // 定位期间已被人处置
          transitionSubtask(sub, 'rejected', { actor: 'human', reason: comment, refs: { sessionId: sub.sessionId } })
          transitionSubtask(sub, 'in-progress', { actor: 'system', reason: '批语已注入，重新排队执行（S5）' })
          sub.round += 1
          sub.attempt = 0
          sub.progressNotes = []
          sub.sessionId = undefined
        }
        task.round += 1
        invalidateTaskEvidence(task)
        task.triageSessionId = undefined
        appendTaskNote(task, {
          actor: 'system',
          kind: 'rework-scope',
          reason: `返工范围（AI 定位${note !== '' ? `：${firstLine(note)}` : ''}）：${scope.join(', ')}`,
        })
      })
      await this.pump()
    } catch {
      // 任务消失/终态等极端情形：静默收敛（会话输入作废）
      await this.mutateQuiet(ledger => {
        const task = findTask(ledger, input.taskId)
        if (task !== null && task.triageSessionId === input.sessionId) task.triageSessionId = undefined
      })
    }
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
        if (sub.status === 'in-progress' && sub.sessionId !== undefined) {
          cancels.push(sub.sessionId)
          // 收敛运行中子任务：任务已终态，残留 in-progress + sessionId 会永久占满
          // 全局 WIP 额度（调度器只放行非终态任务，但历史数据/此前的取消记录需要在此收口）。
          transitionSubtask(sub, 'blocked', { actor: 'system', reason: '任务已取消，执行会话终止（T9）' })
          sub.sessionId = undefined
          sub.attempt = 0
        }
      }
      if (task.status === 'decomposing' && task.decomposeSessionIds.length > 0) {
        const last = task.decomposeSessionIds.at(-1)
        if (last !== undefined) cancels.push(last)
      }
      if (task.finalizeSessionId !== undefined) {
        cancels.push(task.finalizeSessionId)
        task.finalizeSessionId = undefined
      }
      if (task.triageSessionId !== undefined) {
        cancels.push(task.triageSessionId)
        task.triageSessionId = undefined
      }
      for (const sessionId of cancels) this.liveExecutionSessions.delete(sessionId)
      transitionTask(task, 'cancelled', { actor: 'human', reason: '人工取消（T9，二次确认）' })
    })
    for (const sessionId of cancels) {
      this.clearStallTimer(sessionId)
      await this.expireApprovals(sessionId, '任务取消，待裁决审批随之失效')
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
    const counted = new Set<string>()
    for (const task of ledger.tasks) {
      // 终态任务（done/cancelled/archived）不占 WIP 额度：其残留的 in-progress 子任务
      // （取消/归档时的孤儿会话）不得堵死全局调度（见 actionCancelTask 与 boot 清理）。
      if (isTaskTerminal(task.status)) continue
      for (const sub of task.subtasks) {
        if (sub.status === 'in-progress' && sub.sessionId !== undefined && !counted.has(sub.sessionId)) {
          counted.add(sub.sessionId)
          running += 1
        }
      }
    }
    // 证据已受理、适配器尚未收敛的存活会话同样占额度（状态已是 review，账本看不出来）
    for (const sessionId of this.liveExecutionSessions) {
      if (counted.has(sessionId)) continue
      let orphanOfTerminal = false
      for (const task of ledger.tasks) {
        if (!isTaskTerminal(task.status)) continue
        if (task.subtasks.some(s => s.sessionId === sessionId)) {
          orphanOfTerminal = true
          break
        }
      }
      if (orphanOfTerminal) continue
      counted.add(sessionId)
      running += 1
    }
    for (const task of ledger.tasks) {
      if (task.status !== 'in-progress') continue
      if (this.needsPermissionConfirm(task.contract.pins) && !task.permissionConfirmed) {
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
        const modelRefs = { sessionId, ...(modelLabel(this.modelSettings.execution) !== undefined ? { model: modelLabel(this.modelSettings.execution) } : {}) }
        if (sub.status === 'pending') {
          transitionSubtask(sub, 'in-progress', { actor: 'system', reason: '调度器启动执行会话（S2）', refs: modelRefs })
        } else {
          appendSubtaskNote(sub, { actor: 'system', kind: 'session-started', reason: `重启执行会话 attempt ${sub.attempt}`, refs: modelRefs })
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
    this.liveExecutionSessions.add(launch.sessionId)
    if (process.env['TF_TRACE']) console.log('[LIVE+] ' + launch.sessionId)
    this.armStallTimer(launch.sessionId, launch.taskId, launch.subtaskId)
    let outcome: ExecutionOutcome
    try {
      outcome = await this.adapter.runExecutionSession(input)
    } catch (error) {
      outcome = { kind: 'crashed', error: errorMessage(error) }
    } finally {
      // 先摘掉存活标记再走 outcome 处理：handleExecutionOutcome 的 pump 若把
      // 本会话仍计为占额度，下一个子任务会永远发不出车（2026-09-11 回归）。
      if (process.env['TF_TRACE']) console.log('[LIVE-] ' + launch.sessionId)
      this.liveExecutionSessions.delete(launch.sessionId)
    }
    if (this.disposed) return
    if (process.env['TF_TRACE']) console.log('[OUTCOME] ' + launch.sessionId + ' ' + outcome.kind)
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
      model: this.modelSettings.execution,
      executionMode: resolveExecutionMode(task.contract.pins, this.config.sessionDefaultPermission),
      tools: {
        submitEvidence: async payload => this.toolSubmitEvidence(sessionId, payload),
        reportBlocker: async reason => this.toolReportBlocker(sessionId, reason),
        updateProgress: async note => this.toolUpdateProgress(sessionId, note),
      },
      approvals: {
        request: async input => this.toolApprovalRequest(sessionId, input.toolName, input.reason),
      },
    }
  }

  private async handleExecutionOutcome(
    taskId: string,
    subtaskId: string,
    sessionId: string,
    outcome: ExecutionOutcome,
  ): Promise<void> {
    this.clearStallTimer(sessionId)
    await this.expireApprovals(sessionId, '会话结束，未裁决审批随之失效')
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
    let needsFinalCheck = false
    let foundTaskId = ''
    try {
      await this.store.mutate(ledger => {
        const found = findBySession(ledger, sessionId)
        if (found === null) throw new GuardError(`会话 ${sessionId} 不对应任何执行中的子任务`)
        const { task, sub } = found
        foundTaskId = task.id
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
        // T5 延后：全部证据齐备后先跑任务级终检（§4.5），完成（或兜底）才进 review
        if (allSubtasksEvidencedOrDone(task) && task.status === 'in-progress') {
          needsFinalCheck = true
        }
      })
      if (needsFinalCheck) await this.startFinalCheckInternal(foundTaskId, 1)
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

  // —— 审批桥（approval/request → 落库 + 看板裁决，§7.1b）——

  /**
   * approval 模式的会话内提权请求入口（适配器应答方调用）：
   * 落库 pending（事件留痕 + SSE 推送通知）→ 挂起等待 {@link actionDecideApproval} 裁决。
   * auto 模式不会走到这里（适配器直接放行）。
   */
  private async toolApprovalRequest(sessionId: string, toolName: string, reason?: string): Promise<'allowed' | 'rejected'> {
    const snapshot = this.store.snapshot()
    const found = findBySession(snapshot, sessionId)
    if (found === null || found.task.status === 'cancelled' || found.task.status === 'archived') return 'rejected'
    const taskId = found.task.id
    const subtaskId = found.sub.id
    const approvalId = `ap_${randomId()}`
    let resolveFn: (decision: 'allowed' | 'rejected') => void = () => undefined
    const decisionPromise = new Promise<'allowed' | 'rejected'>(resolve => { resolveFn = resolve })
    this.pendingApprovals.set(approvalId, resolveFn)
    try {
      await this.store.mutate(ledger => {
        const task = findTask(ledger, taskId)
        const sub = task === null ? undefined : findSubtask(task, subtaskId)
        if (task === null || sub === undefined || sub.status !== 'in-progress' || sub.sessionId !== sessionId) {
          throw new GuardError('会话不在执行中，审批不再受理')
        }
        const record: ApprovalRecord = {
          id: approvalId,
          subtaskId,
          sessionId,
          toolName,
          ...(reason !== undefined ? { reason } : {}),
          status: 'pending',
          createdAt: Date.now(),
        }
        const approvals = task.approvals ?? (task.approvals = [])
        approvals.push(record)
        if (approvals.length > MAX_APPROVALS) {
          const finished = approvals.findIndex(a => a.status !== 'pending')
          approvals.splice(finished >= 0 ? finished : 0, 1)
        }
        appendSubtaskNote(sub, {
          actor: 'ai',
          kind: 'approval-requested',
          reason: `工具 ${toolName} 请求提权${reason !== undefined ? `：${firstLine(reason)}` : ''}，等待人工审批`,
          refs: { sessionId },
        })
      })
    } catch {
      this.pendingApprovals.delete(approvalId)
      return 'rejected'
    }
    return decisionPromise
  }

  /** 人在看板/通知栏裁决审批（两档：allow = 本会话完全放行；reject = 仅拒这一次）。 */
  private async actionDecideApproval(action: Extract<TaskflowAction, { type: 'decideApproval' }>): Promise<DispatchResult> {
    const snapshot = this.store.snapshot()
    const task0 = findTask(snapshot, action.taskId)
    const record0 = task0?.approvals?.find(a => a.id === action.approvalId)
    if (task0 === null || task0 === undefined || record0 === undefined) {
      return { ok: false, code: 'not-found', error: `approval ${action.approvalId} not found` }
    }
    if (record0.status !== 'pending') {
      return { ok: false, code: 'guard', error: `approval ${action.approvalId} 已裁决（${record0.status}）` }
    }
    if (action.decision === 'allow') {
      // 完全放行 = 会话预设原地提升；失败（会话已结束/宿主拒绝）则闭环为 expired 并报给 UI
      const elevated = await (this.adapter.elevateSession?.(record0.sessionId, 'workspace-write') ?? Promise.resolve(true))
        .catch(() => false)
      if (!elevated) {
        await this.expireApprovals(record0.sessionId, '完全放行失败：会话预设提升未成功')
        return { ok: false, code: 'guard', error: '会话预设提升失败（会话可能已结束）；若会话仍在运行会重新发起审批' }
      }
    }
    await this.store.mutate(ledger => {
      const task = findTask(ledger, action.taskId)
      if (task === null) throw new GuardError(`task ${action.taskId} not found`)
      const record = task.approvals?.find(a => a.id === action.approvalId)
      if (record === undefined || record.status !== 'pending') {
        throw new GuardError(`approval ${action.approvalId} 已裁决或不存在`)
      }
      record.status = action.decision === 'allow' ? 'elevated' : 'rejected'
      record.decidedAt = Date.now()
      if (action.note !== undefined && action.note.trim().length > 0) record.note = action.note
      const sub = findSubtask(task, record.subtaskId)
      if (sub !== undefined) {
        appendSubtaskNote(sub, {
          actor: 'human',
          kind: action.decision === 'allow' ? 'approval-elevated' : 'approval-rejected',
          reason: action.decision === 'allow'
            ? `完全放行：会话预设提升为 workspace-write，后续不再逐次审批${action.note !== undefined && action.note.trim().length > 0 ? `（批语：${firstLine(action.note)}）` : ''}`
            : `拒绝本次提权（${record.toolName}）${action.note !== undefined && action.note.trim().length > 0 ? `：${firstLine(action.note)}` : ''}`,
          refs: { sessionId: record.sessionId },
        })
      }
    })
    this.resolvePending(action.approvalId, action.decision === 'allow' ? 'allowed' : 'rejected')
    return { ok: true, revision: this.currentRevision(), taskId: action.taskId }
  }

  /** 把某会话的全部 pending 审批闭环为 expired（取消/结束/恢复路径），并释放等待中的应答方。 */
  private async expireApprovals(sessionId: string, reason: string): Promise<void> {
    const ids: string[] = []
    await this.mutateQuiet(ledger => {
      for (const task of ledger.tasks) {
        const approvals = task.approvals
        if (approvals === undefined) continue
        for (const record of approvals) {
          if (record.sessionId === sessionId && record.status === 'pending') {
            record.status = 'expired'
            record.decidedAt = Date.now()
            record.note = reason
            ids.push(record.id)
          }
        }
      }
    })
    for (const id of ids) this.resolvePending(id, 'rejected')
  }

  private resolvePending(approvalId: string, decision: 'allowed' | 'rejected'): void {
    const resolver = this.pendingApprovals.get(approvalId)
    if (resolver !== undefined) {
      this.pendingApprovals.delete(approvalId)
      resolver(decision)
    }
  }

  // —— 看门狗（G2：无声挂起可见化）——

  /** 会话启动/接管时武装；有 pending 审批时视为「等人」顺延，其他静默超时 → blocked（可重试）。 */
  private armStallTimer(sessionId: string, taskId: string, subtaskId: string): void {
    this.clearStallTimer(sessionId)
    if (this.config.sessionStallTimeoutMin <= 0 || this.disposed) return
    const timer = setTimeout(() => {
      void this.onStallTimeout(sessionId, taskId, subtaskId)
    }, this.config.sessionStallTimeoutMin * 60_000)
    this.stallTimers.set(sessionId, timer)
  }

  private clearStallTimer(sessionId: string): void {
    const timer = this.stallTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.stallTimers.delete(sessionId)
    }
  }

  private async onStallTimeout(sessionId: string, taskId: string, subtaskId: string): Promise<void> {
    this.stallTimers.delete(sessionId)
    if (this.disposed) return
    const snapshot = this.store.snapshot()
    const task = snapshot.tasks.find(t => t.id === taskId)
    const sub = task?.subtasks.find(s => s.id === subtaskId)
    if (task === undefined || sub === undefined || sub.status !== 'in-progress' || sub.sessionId !== sessionId) return
    const waitingApproval = (task.approvals ?? []).some(a => a.sessionId === sessionId && a.status === 'pending')
    if (waitingApproval) {
      // 等人不算停滞：审批卡已可见并有通知；顺延一个周期继续等
      this.armStallTimer(sessionId, taskId, subtaskId)
      return
    }
    await this.mutateQuiet(ledger => {
      const t = findTask(ledger, taskId)
      const s = t === null ? undefined : findSubtask(t, subtaskId)
      if (t === null || s === undefined || s.status !== 'in-progress' || s.sessionId !== sessionId) return
      appendSubtaskNote(s, {
        actor: 'system',
        kind: 'session-stalled',
        reason: `看门狗：会话静默超过 ${this.config.sessionStallTimeoutMin} 分钟且无待裁决审批`,
        refs: { sessionId },
      })
      transitionSubtask(s, 'blocked', { actor: 'system', reason: `会话静默超时（看门狗 ${this.config.sessionStallTimeoutMin}min，T8）` })
      if (t.status === 'in-progress') {
        transitionTask(t, 'blocked', { actor: 'system', reason: `子任务 ${s.id} 会话静默超时（T8）` })
      }
    })
    this.liveExecutionSessions.delete(sessionId) // 看门狗判死：会话不再占 WIP 额度
    await this.adapter.cancelSession(sessionId).catch(() => undefined)
    await this.pump()
  }

  // —— 杂项 ——

  private needsPermissionConfirm(pins: Pins): boolean {
    // 完全权限（executionMode=auto）：提权自动放行，创建时已选「不打扰」，免确认门；
    // approval 档（或旧任务按权限推导出的 approval）才在权限高于会话默认时要求确认。
    if (resolveExecutionMode(pins, this.config.sessionDefaultPermission) === 'auto') return false
    return pins.permission !== this.config.sessionDefaultPermission
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

/** 对单个子任务执行 S5 返工：review → rejected（落批语）→ in-progress（重新排队）。 */
function reworkSubtaskInPlace(task: Task, subtaskId: string, comment: string): void {
  const sub = findSubtask(task, subtaskId)
  if (sub === undefined) throw new GuardError(`subtask ${subtaskId} not found`)
  if (sub.status !== 'review') {
    throw new GuardError(`subtask ${subtaskId} 状态为 ${sub.status}，仅 review 可打回（S5）`)
  }
  transitionSubtask(sub, 'rejected', { actor: 'human', reason: comment, refs: { sessionId: sub.sessionId } })
  transitionSubtask(sub, 'in-progress', { actor: 'system', reason: '批语已注入，重新排队执行（S5）' })
  sub.round += 1
  sub.attempt = 0
  sub.progressNotes = []
  sub.sessionId = undefined
}

/** 任务进入返工迭代：任务级终检证据随之作废（终检将在子任务重新齐备后重跑）。 */
function invalidateTaskEvidence(task: Task): void {
  if (task.evidence !== undefined) {
    appendTaskNote(task, { actor: 'system', kind: 'task-evidence-invalidated', reason: '任务重新进入迭代，上一份任务级终检证据作废' })
    task.evidence = undefined
  }
  // 终检中的会话产出同样作废（runFinalCheck 以 finalizeSessionId 匹配，清空即丢弃）
  task.finalizeSessionId = undefined
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
