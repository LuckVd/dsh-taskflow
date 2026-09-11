/**
 * dsh 宿主适配器：把引擎的会话需求映射到真实 DSH AgentRegistry。
 *
 * - 拆解/执行会话 = 真实 DSH 会话（ctx.agents.create + followup + whenIdle）；
 * - 执行会话的工具面经 agent setup 注册（仅该会话可见）；
 * - pins 应用顺序（§7.2 fail-closed）：工作区校验 → 预设校验 → 权限应用，
 *   任一失败在提示词发出前中止（抛错 → 引擎转 blocked）。
 *
 * @module dsh-taskflow/host
 */

import { existsSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// 类型-only 导入：引入宿主对 cordis Context 的事件增强（agent/created），零运行时依赖。
import type {} from '@deepseek-ai/dsh-agent'
import { asSessionId, createUserMessage, type SessionId } from './compat.ts'
import type { DecomposeResult, DecomposeSessionInput, ExecutionOutcome, ExecutionSessionInput, FinalCheckSessionInput, SessionAdapter, TriageSessionInput } from '../engine.ts'
import type { SessionModelSelection } from '../../protocol/types.ts'
import { registerTaskflowTools } from './tools.ts'

export interface DshAdapterOptions {
  /** 宿主插件上下文（需注入 agents / sessionPersistence / permissionPresets / agentDefaultModel）。 */
  ctx: Context
  /** pins.workspace 为空时的落点（宿主默认工作区）。 */
  defaultWorkspace: string
  /** 权限预设缺省值（引擎配置的 sessionDefaultPermission 一致）。 */
  defaultPermission: string
  /** 读取宿主默认模型选择（agentDefaultModel.currentSelection()）；缺省时会话无法组装提示词。 */
  defaultModelSelection?: () => ModelSelection | undefined
}

/** 会话的模型选择（协议层共享类型；同宿主 agentDefaultModel 的选择类型）。 */
export type ModelSelection = SessionModelSelection

interface AdapterServices {
  agents: {
    create(options: unknown): Promise<{ agent: { session: { events: SessionEvent[]; id: SessionId }; followup(message: unknown): void; whenIdle(): Promise<void> }; dispose(): Promise<void> }>
    resume(options: unknown): Promise<{ agent: { session: { events: SessionEvent[] }; followup(message: unknown): void; whenIdle(): Promise<void> }; dispose(): Promise<void> }>
    get(id: SessionId): { cancel(cause?: unknown, options?: unknown): void } | undefined
  }
  sessionPersistence: {
    list(signal?: AbortSignal): Promise<Array<{ id: SessionId }>>
  }
  permissionPresets?: {
    names: readonly string[]
    set(session: unknown, name: string): void
  }
  agentPresets?: {
    /** 把会话挂到预设的 standing mount（工具/提示词/技能目录来源）；id 缺省 = 宿主默认预设。 */
    mount?(agentCtx: unknown, id?: string): Promise<unknown>
    list?(): Array<{ id?: string; name?: string }> | Map<string, unknown>
  }
}

export class DshSessionAdapter implements SessionAdapter {
  readonly kind = 'dsh'
  private readonly services: AdapterServices
  /** 运行中会话的存活跟踪（sessionId → session），供 elevateSession 原地提权。 */
  private readonly liveSessions = new Map<string, unknown>()

  constructor(private readonly options: DshAdapterOptions) {
    const ctx = options.ctx as unknown as Record<string, unknown>
    this.services = {
      agents: ctx['agents'] as AdapterServices['agents'],
      sessionPersistence: ctx['sessionPersistence'] as AdapterServices['sessionPersistence'],
      permissionPresets: ctx['permissionPresets'] as AdapterServices['permissionPresets'] | undefined,
      agentPresets: ctx['agentPresets'] as AdapterServices['agentPresets'] | undefined,
    }
  }

  /** decideApproval「完全放行」：把运行中会话的权限预设原地提升。 */
  async elevateSession(sessionId: string, preset: string): Promise<boolean> {
    const session = this.liveSessions.get(sessionId)
    const presets = this.services.permissionPresets
    if (session === undefined || presets === undefined) return false
    try {
      presets.set(session, preset)
      return true
    } catch {
      return false
    }
  }

  async runDecomposeSession(input: DecomposeSessionInput): Promise<DecomposeResult> {
    return this.runJsonSession(input, '拆解')
  }

  /** 任务级终检会话（§4.5，2026-09-11 语义升级）：JSON 文本输出，形制同拆解。 */
  async runFinalCheckSession(input: FinalCheckSessionInput): Promise<DecomposeResult> {
    return this.runJsonSession(input, '终检')
  }

  /** 打回定位会话（§4.6，2026-09-11 语义升级）：JSON 文本输出，形制同拆解。 */
  async runTriageSession(input: TriageSessionInput): Promise<DecomposeResult> {
    return this.runJsonSession(input, '打回定位')
  }

  /** 通用 JSON 会话：创建 → followup(prompt) → 取最后 assistant 文本 → 提取 JSON 对象。 */
  private async runJsonSession(input: DecomposeSessionInput, label: string): Promise<DecomposeResult> {
    try {
      const handle = await this.createAgent(input, undefined)
      try {
        await handle.agent.whenIdle().catch(() => undefined)
        handle.agent.followup(this.buildMessage(input.prompt))
        await handle.agent.whenIdle()
        const text = lastAssistantText(handle.agent.session)
        const json = extractJsonObject(text)
        if (json === undefined) {
          return { kind: 'failed', error: `${label}会话未产出 JSON（最后输出：${text.slice(0, 200)}）` }
        }
        return { kind: 'ok', output: json }
      } finally {
        await handle.dispose().catch(() => undefined)
      }
    } catch (error) {
      return { kind: 'failed', error: errorMessage(error) }
    }
  }

  async runExecutionSession(input: ExecutionSessionInput): Promise<ExecutionOutcome> {
    try {
      const handle = await this.createAgent(input, input.tools)
      this.liveSessions.set(input.sessionId, handle.agent.session)
      try {
        await handle.agent.whenIdle().catch(() => undefined)
        handle.agent.followup(this.buildMessage(input.prompt))
        await handle.agent.whenIdle()
        return { kind: 'completed' }
      } finally {
        this.liveSessions.delete(input.sessionId)
        await handle.dispose().catch(() => undefined)
      }
    } catch (error) {
      return { kind: 'crashed', error: errorMessage(error) }
    }
  }

  /** 重启接管：resume 既有会话并重新注册工具面，等待其收敛。 */
  async adoptSession(input: ExecutionSessionInput): Promise<ExecutionOutcome> {
    try {
      // 模型选择：会话输入自带（全局设置）优先，缺省回退宿主默认。
      const selection = input.model ?? this.options.defaultModelSelection?.()
      const handle = await this.services.agents.resume({
        resumeSessionId: asSessionId(input.sessionId),
        ...(selection !== undefined ? { agentOptions: agentOptionsOf(selection) } : {}),
        setup: async (agentCtx: Context) => {
          const roster = this.services.agentPresets
          if (roster?.mount !== undefined) {
            try {
              await roster.mount(agentCtx as unknown, undefined)
            } catch {
              // 接管时预设不可用：会话回退空层，仍可收敛（引擎转 blocked 兜底）
            }
          }
          if (selection !== undefined) installModelSelection(agentCtx, selection)
          registerTaskflowTools(agentCtx, input.tools, input.sessionId)
          registerApprovalAnswerer(agentCtx, input)
        },
      } as unknown as Parameters<AdapterServices['agents']['resume']>[0])
      this.liveSessions.set(input.sessionId, handle.agent.session)
      try {
        await handle.agent.whenIdle()
        return { kind: 'completed' }
      } finally {
        this.liveSessions.delete(input.sessionId)
        await handle.dispose().catch(() => undefined)
      }
    } catch (error) {
      return { kind: 'crashed', error: errorMessage(error) }
    }
  }

  async hasSessionRecord(sessionId: string): Promise<boolean> {
    try {
      const headers = await this.services.sessionPersistence.list()
      return headers.some(header => header.id === sessionId)
    } catch {
      return false
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    try {
      this.services.agents.get(asSessionId(sessionId))?.cancel('taskflow-cancel')
    } catch {
      // 尽力而为（T9）
    }
  }

  // —— 内部 ——

  private buildMessage(prompt: string): unknown {
    return createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-taskflow' },
    })
  }

  /** pins 应用（fail-closed）+ 会话创建。 */
  private async createAgent(
    input: DecomposeSessionInput | ExecutionSessionInput,
    tools: ExecutionSessionInput['tools'] | undefined,
  ): Promise<ReturnType<AdapterServices['agents']['create']>> {
    // 模型选择：会话输入自带（全局设置两槽，§PLAN-MODEL）优先，缺省回退宿主默认模型
    // （无它提示词组装缺 {{model}} 变量，turn 即报错）。
    const selection = input.model ?? this.options.defaultModelSelection?.()
    const workspace = input.workspace.trim().length > 0 ? input.workspace : this.options.defaultWorkspace
    if (workspace.trim().length > 0 && !isDirectory(workspace)) {
      throw new Error(`工作区不存在或不是目录：${workspace}（fail-closed，§7.2）`)
    }
    const presetId = input.presetId
    if (presetId !== null && presetId !== undefined && presetId.trim().length > 0) {
      const presets = (this.options.ctx as unknown as Record<string, unknown>)['agentPresets'] as
        | { list?(): Array<{ id?: string; name?: string }> | Map<string, unknown> }
        | undefined
      if (presets?.list !== undefined) {
        const listed = presets.list()
        const ids = Array.isArray(listed)
          ? listed.map(p => p.id ?? p.name ?? '')
          : [...listed.keys()].map(String)
        if (!ids.includes(presetId)) {
          throw new Error(`Agent 预设不存在：${presetId}（fail-closed，§7.2；可用：${ids.join(', ') || '无'}）`)
        }
      }
    }
    return this.services.agents.create({
      sessionId: asSessionId(input.sessionId),
      meta: {
        ...(workspace.trim().length > 0 ? { cwd: workspace } : {}),
        ...(presetId !== null && presetId !== undefined && presetId.trim().length > 0 ? { agentPreset: presetId } : {}),
      },
      ...(selection !== undefined ? { agentOptions: agentOptionsOf(selection) } : {}),
      setup: async (agentCtx: Context) => {
        // 预设挂载（§7.2）：pins.presetId 为空 → 宿主默认预设。
        // 工具、提示词段、技能目录都来自预设组合；不挂载 = 空层会话（无 bash/fs 工具）。
        const roster = this.services.agentPresets
        if (roster?.mount !== undefined) {
          const wanted = presetId !== null && presetId !== undefined && presetId.trim().length > 0 ? presetId : undefined
          await roster.mount(agentCtx as unknown, wanted)
        }
        if (selection !== undefined) installModelSelection(agentCtx, selection)
        // 权限应用：agent/created 在 setup 完成后、发布时触发（schedule 插件同款时序）。
        // 应用任务声明的权限预设（§7.2 pins fail-closed）；未知预设名保持创建时形态。
        const presets = this.services.permissionPresets
        if (presets !== undefined) {
          const stop = agentCtx.on('agent/created', ({ agent }: { agent: { session: unknown } }) => {
            try {
              presets.set(agent.session, input.permission)
            } catch {
              // 未知预设名：保持创建时权限（引擎的权限确认门已兜底）
            }
          })
          void stop
        }
        if (tools !== undefined) {
          registerTaskflowTools(agentCtx, tools, input.sessionId)
          if (isExecutionInput(input)) registerApprovalAnswerer(agentCtx, input)
        }
      },
    })
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 取最后一条 assistant 文本的拼接（rc.1 事件形如 {type, data}，data 承载负载；兼容扁平形态）。 */
function lastAssistantText(session: unknown): string {
  const source = session as { snapshotEvents?: () => unknown; events?: unknown }
  const events = (typeof source.snapshotEvents === 'function' ? source.snapshotEvents() : source.events) as Iterable<unknown> | undefined
  const parts: string[] = []
  for (const event of events ?? []) {
    const record = (event ?? {}) as { type?: unknown; data?: { message?: { content?: unknown } }; message?: { content?: unknown } }
    if (record.type !== 'assistant/message') continue
    parts.length = 0
    const content = record.data?.message?.content ?? record.message?.content ?? []
    for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** AgentOptions 投影（provider/model/reasoningEffort，同宿主 AgentOptions）。 */
function agentOptionsOf(selection: ModelSelection): { provider: string; model: string; reasoningEffort?: string } {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
  }
}

/**
 * 把模型选择耦合进会话的提示词组装与请求路由（同宿主 installModelSelection）：
 * - system-prompt/assemble：向组装变量注入 provider/model（缺它则 {{model}} 无值）；
 * - agent/request：把解析后的请求路由到选定的 provider/model 路由。
 */
function installModelSelection(agentCtx: Context, selection: ModelSelection): () => void {
  let assembled: ModelSelection | undefined
  const on = agentCtx.on as unknown as (event: string, listener: (...args: never[]) => unknown) => () => void
  const disposeAssembly = on('system-prompt/assemble', (async (
    _assembly: unknown,
    _context: unknown,
    next: () => Promise<{ variables?: Record<string, unknown> }>,
  ) => {
    const result = await next()
    assembled = selection
    return {
      ...result,
      variables: { ...result.variables, provider: selection.provider, model: selection.model },
    }
  }) as (...args: never[]) => unknown)
  const disposeRequest = on('agent/request', (async (
    _payload: unknown,
    next: () => Promise<Record<string, unknown>>,
  ) => {
    const resolved = await next()
    const selected = assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inherited, ...withoutInherited } = resolved
    return {
      ...withoutInherited,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort !== undefined ? { reasoningEffort: selected.reasoningEffort } : {}),
    }
  }) as (...args: never[]) => unknown)
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}

/** 从自由文本中提取第一个平衡的 JSON 对象（结构化输出协议的容错解析）。 */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = [fenced?.[1], text]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const start = candidate.indexOf('{')
    if (start < 0) continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 输入是否为执行会话（携带执行模式与审批桥）。 */
function isExecutionInput(input: DecomposeSessionInput | ExecutionSessionInput): input is ExecutionSessionInput {
  return 'executionMode' in input && input.executionMode !== undefined && 'approvals' in input
}

/**
 * 提权审批应答方（§7.1b，dsh-acp 同款宿主形态 ctx.on("approval/request")）：
 * - auto：直接放行（宿主照常落 approval/asked+decided 审计对，零打扰）；
 * - approval：转引擎审批桥（落库 pending + SSE 通知 + 看板裁决），Promise 挂起直到人裁决。
 * 不注册 = 落回宿主默认瀑布流（GUI 只应答当前打开的会话 → 后台会话无人应答挂死，即本轮复盘根因）。
 */
function registerApprovalAnswerer(agentCtx: Context, input: ExecutionSessionInput): void {
  if (input.executionMode !== 'auto' && input.executionMode !== 'approval') return
  const on = agentCtx.on as unknown as (event: string, listener: (...args: never[]) => unknown) => () => void
  const stop = on('approval/request', ((
    request: { toolName: string; reason?: string },
    next: () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>,
  ) => {
    void next
    if (input.executionMode === 'auto') return 'allowed-once'
    return input.approvals
      .request({ sessionId: input.sessionId, toolName: request.toolName, reason: request.reason })
      .then(decision => (decision === 'allowed' ? 'allowed-once' : 'rejected'))
      .catch(() => 'rejected')
  }) as (...args: never[]) => unknown)
  void stop
}
