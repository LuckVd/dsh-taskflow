/**
 * 测试用 mock 会话适配器：脚本化 AI 行为，记录全部调用供断言。
 * 不属于生产代码路径；用于单测/E2E 与客户端渲染冒烟。
 *
 * @module dsh-taskflow/host
 */

import type {
  AgentToolSurface,
  DecomposeResult,
  DecomposeSessionInput,
  ExecutionSessionInput,
  ExecutionOutcome,
  FinalCheckSessionInput,
  SessionAdapter,
  TriageSessionInput,
} from '../engine.ts'
import type { Ledger } from '../../protocol/types.ts'

export interface MockAdapterOptions {
  /** 引擎权威状态读取口（行为脚本据此构造合法证据）。 */
  getLedger: () => Ledger
}

export type DecomposeBehavior = (input: DecomposeSessionInput, callIndex: number) => DecomposeResult | Promise<DecomposeResult>

export type ExecutionBehavior = (
  input: ExecutionSessionInput,
  call: { index: number; round: number; attempt: number },
) => Promise<void>

/**
 * 可脚本化 mock 适配器。默认行为：
 * - 拆解：产出合法的 2 子任务输出（含任务级验收建议稿）；
 * - 执行：提交三要素齐全、全 pass 的证据；
 * - 终检：产出与任务级验收标准逐条对应、全 pass 的任务级证据；
 * - 打回定位：返回全部 review 态子任务（等价旧的全量打回语义）。
 * 测试用 `decomposeBehavior` / `executionBehavior` / `finalizeBehavior` / `triageBehavior` 覆盖。
 */
export class MockSessionAdapter implements SessionAdapter {
  readonly kind = 'mock'
  decomposeBehavior?: DecomposeBehavior
  executionBehavior?: ExecutionBehavior
  finalizeBehavior?: DecomposeBehavior
  triageBehavior?: DecomposeBehavior

  readonly decomposeRuns: DecomposeSessionInput[] = []
  readonly executionRuns: ExecutionSessionInput[] = []
  readonly finalizeRuns: FinalCheckSessionInput[] = []
  readonly triageRuns: TriageSessionInput[] = []
  readonly cancelled: string[] = []
  readonly knownSessions = new Set<string>()

  constructor(private readonly options: MockAdapterOptions) {}

  private getLedger(): Ledger {
    return this.options.getLedger()
  }

  async runDecomposeSession(input: DecomposeSessionInput): Promise<DecomposeResult> {
    this.decomposeRuns.push(input)
    this.knownSessions.add(input.sessionId)
    const behavior = this.decomposeBehavior ?? defaultDecomposeBehavior(this.getLedger())
    return behavior(input, this.decomposeRuns.length)
  }

  async runExecutionSession(input: ExecutionSessionInput): Promise<ExecutionOutcome> {
    this.executionRuns.push(input)
    this.knownSessions.add(input.sessionId)
    const task = this.getLedger().tasks.find(t => t.id === input.taskId)
    const sub = task?.subtasks.find(s => s.id === input.subtaskId)
    const behavior = this.executionBehavior ?? defaultExecutionBehavior(this.getLedger())
    try {
      await behavior(input, { index: this.executionRuns.length, round: sub?.round ?? 1, attempt: sub?.attempt ?? 1 })
      return { kind: 'completed' }
    } catch (error) {
      return { kind: 'crashed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  async runFinalCheckSession(input: FinalCheckSessionInput): Promise<DecomposeResult> {
    this.finalizeRuns.push(input)
    this.knownSessions.add(input.sessionId)
    const behavior = this.finalizeBehavior ?? defaultFinalizeBehavior(this.getLedger())
    return behavior(input, this.finalizeRuns.length)
  }

  async runTriageSession(input: TriageSessionInput): Promise<DecomposeResult> {
    this.triageRuns.push(input)
    this.knownSessions.add(input.sessionId)
    const behavior = this.triageBehavior ?? defaultTriageBehavior(this.getLedger())
    return behavior(input, this.triageRuns.length)
  }

  async hasSessionRecord(sessionId: string): Promise<boolean> {
    return this.knownSessions.has(sessionId)
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId)
    this.knownSessions.delete(sessionId)
  }
}

/** 默认拆解行为：合法 2 子任务。 */
export function defaultDecomposeBehavior(ledger: Ledger): DecomposeBehavior {
  return input => {
    const task = ledger.tasks.find(t => t.id === input.taskId)
    const acceptanceGiven = (task?.contract.acceptance.length ?? 0) > 0
    return {
      kind: 'ok',
      output: {
        taskAcceptance: acceptanceGiven
          ? (task?.contract.acceptance ?? []).map(a => ({ text: a.text }))
          : [{ text: '主流程可端到端跑通（mock 验收 1）' }, { text: '全部命令退出码 0（mock 验收 2）' }],
        subtasks: [
          {
            title: '实现核心逻辑',
            detail: '按合同实现核心逻辑并自测。',
            acceptance: [{ text: '核心逻辑测试通过' }],
            deps: [],
          },
          {
            title: '端到端验证',
            detail: '运行端到端验证命令并留存输出。',
            acceptance: [{ text: '端到端验证命令输出 OK' }],
            deps: [],
          },
        ],
      },
    }
  }
}

/** 默认执行行为：提交三要素齐全、全 pass 证据。 */
export function defaultExecutionBehavior(ledger: Ledger): ExecutionBehavior {
  return async input => {
    const result = await input.tools.submitEvidence(buildPassingEvidence(ledger, input.subtaskId))
    if (!result.accepted) throw new Error(`mock evidence rejected: ${result.correction}`)
  }
}

/** 构造与子任务 acceptance 逐条对应的「全 pass」证据。 */
export function buildPassingEvidence(ledger: Ledger, subtaskId: string): unknown {
  const sub = ledger.tasks.flatMap(t => t.subtasks).find(s => s.id === subtaskId)
  if (sub === undefined) throw new Error(`mock: subtask ${subtaskId} not found`)
  return {
    changesSummary: `（mock）完成 ${sub.title}：按验收标准实现并验证。`,
    verification: [
      { label: 'mock-verify', output: 'OK — all checks passed', passed: true },
    ],
    selfCheck: sub.acceptance.map(a => ({ acceptanceId: a.id, verdict: 'pass', note: 'mock 全过' })),
    diffSummary: '+10 −2（mock 文件）',
  }
}

/** 默认终检行为：与任务级验收标准逐条对应、全 pass 的任务级证据。 */
export function defaultFinalizeBehavior(ledger: Ledger): DecomposeBehavior {
  return input => {
    const task = ledger.tasks.find(t => t.id === input.taskId)
    return {
      kind: 'ok',
      output: {
        changesSummary: `（mock）任务「${task?.title}」终检：整体交付对照任务级验收标准逐条核验通过。`,
        verification: [{ label: 'mock-final-verify', output: 'OK — final review passed', passed: true }],
        selfCheck: (task?.contract.acceptance ?? []).map(a => ({ acceptanceId: a.id, verdict: 'pass', note: 'mock 终检全过' })),
      },
    }
  }
}

/** 默认打回定位行为：全部 review 态子任务（等价旧的全量打回语义）。 */
export function defaultTriageBehavior(ledger: Ledger): DecomposeBehavior {
  return input => {
    const task = ledger.tasks.find(t => t.id === input.taskId)
    return {
      kind: 'ok',
      output: {
        reworkSubtaskIds: (task?.subtasks ?? []).filter(s => s.status === 'review').map(s => s.id),
        note: '（mock）默认全量返工',
      },
    }
  }
}

export type { AgentToolSurface }
