/**
 * 客户端渲染冒烟（jsdom）：真实构建产物 dist/client.iife.js + 真实引擎。
 * 验证：挂载、看板四列、卡片、抽屉五区、验收页证据、打回流、三态 aria。
 */
import { readFileSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_CONFIG, TaskflowEngine } from '../../src/host/engine.ts'
import type { DispatchResult } from '../../src/host/engine.ts'
import { LedgerStore } from '../../src/host/ledger.ts'
import { MockSessionAdapter, buildPassingEvidence } from '../../src/host/mock/session-adapter.ts'
import { handleTaskflowRequest } from '../../src/host/http.ts'
import { cleanup, tempDir, waitFor } from '../helpers.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '../../dist/client.iife.js')

describe.skipIf(!existsSync(bundlePath))('客户端渲染冒烟（dist 产物 + 真实引擎）', () => {
  let dom: JSDOM
  let engine: TaskflowEngine
  let adapter: MockSessionAdapter
  let dir: string
  let unmount: (() => void) | undefined

  beforeAll(async () => {
    dir = await tempDir('taskflow-ui-')
    const box: { engine?: TaskflowEngine } = {}
    adapter = new MockSessionAdapter({ getLedger: () => box.engine!.getState().ledger })
    engine = new TaskflowEngine(new LedgerStore(path.join(dir, 'ledger.json')), adapter, DEFAULT_ENGINE_CONFIG)
    box.engine = engine
    await engine.boot()
    const created = await engine.dispatch({
      type: 'createTask',
      requestId: 'ui-seed',
      title: '给计算器加上百分比按钮',
      description: '补百分比运算与测试。',
    })
    expect(created.ok).toBe(true)
    // 等主流程跑到待验收
    await waitFor(() => engine.getState().ledger.tasks.find(t => t.id === created.taskId)?.status === 'review')

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://127.0.0.1:4173/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      virtualConsole: new VirtualConsole(),
    })
    const { window } = dom

    // fetch → 真实引擎（同款 HTTP 处理器）
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://127.0.0.1:4173')
      const body = init?.body !== undefined ? String(init.body) : undefined
      const result = await handleTaskflowRequest(engine, init?.method ?? 'GET', url.pathname, body)
      return {
        ok: result.status < 400,
        status: result.status,
        async json() {
          return JSON.parse(result.body)
        },
      } as unknown as Response
    }) as typeof fetch
    // EventSource → 引擎订阅
    const listeners: Array<(kind: string) => void> = []
    window.EventSource = class {
      constructor() {
        engine.subscribe(() => {
          for (const listener of listeners.splice(0)) listener('change')
        })
      }
      addEventListener(_kind: string, handler: (kind: string) => void): void {
        listeners.push(handler)
      }
      close(): void {}
    } as unknown as typeof EventSource

    window.eval(readFileSync(bundlePath, 'utf8') + ';window.__taskflowTest = __taskflowTest;')
    const api = (window as unknown as { __taskflowTest: { mountTaskflow(root: HTMLElement, transport: unknown): () => void } }).__taskflowTest
    expect(api).toBeTruthy()
    // 设置/模型目录走真实 HTTP 处理器（与浏览器 fetch shim 同一条路径）
    const callApi = async (method: string, pathname: string, body?: string): Promise<{ status: number; json: any }> => {
      const result = await handleTaskflowRequest(engine, method, pathname, body)
      return { status: result.status, json: JSON.parse(result.body) }
    }
    unmount = api.mountTaskflow(window.document.getElementById('root')!, {
      // F4 秒开接口：测试无预热缓存，返回 null 走骨架屏 → refresh 正常对账
      getCachedState: () => null,
      getState: () => engine.getState(),
      dispatch: (action: unknown) => engine.dispatch(action) as Promise<DispatchResult>,
      subscribe: (onChange: () => void) => engine.subscribe(onChange),
      getSettings: async () => (await callApi('GET', '/api/taskflow/settings')).json,
      saveSettings: async (next: unknown) => {
        const response = await callApi('PUT', '/api/taskflow/settings', JSON.stringify(next))
        if (response.status >= 400) throw new Error(`settings ${response.status}`)
        return response.json
      },
      getArtifactPreview: async (taskId: string, artifactPath: string) =>
        engine.readArtifactPreview(taskId, artifactPath),
      getModels: async () => ({
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        groups: [
          { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] },
          { id: 'ollama', name: 'Ollama（本机）', models: [{ id: 'qwen3:8b', name: 'qwen3:8b' }] },
        ],
      }),
    })
  })

  afterAll(async () => {
    unmount?.()
    await cleanup(dir)
  })

  it('看板渲染：四列 + 卡片 + 角标 + aria', async () => {
    const doc = dom.window.document
    await waitFor(() => doc.querySelectorAll('.tf-card').length >= 1)
    // React 提交后断言（waitFor 保证卡片已渲染，列随卡片同批提交）
    await waitFor(() => doc.querySelectorAll('.tf-column').length === 4)
    expect(doc.querySelectorAll('.tf-column[role="list"]')).toHaveLength(4)
    const card = doc.querySelector('.tf-card')!
    expect(card.textContent).toContain('给计算器加上百分比按钮')
    const badge = doc.querySelector('[role="status"]')!
    expect(badge.textContent).toContain('待验收 1')
    expect(doc.querySelector('[aria-label="搜索任务"]')).toBeTruthy()
  })

  it('详情弹窗：五区标签 + 合同 + 子任务 + 证据报告卡', async () => {
    const doc = dom.window.document
    ;(doc.querySelector('.tf-card') as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-modal') !== null)
    expect(doc.querySelector('.tf-modal[aria-modal="true"]')).toBeTruthy()
    const tabs = [...doc.querySelectorAll('.tf-tab')].map(el => el.textContent)
    expect(tabs.join(',')).toContain('合同')
    expect(tabs.join(',')).toContain('子任务')
    expect(tabs.join(',')).toContain('验收')
    expect(tabs.join(',')).toContain('历史')
    expect(tabs.join(',')).toContain('拆解记录')

    // 子任务标签
    const subtasksTab = [...doc.querySelectorAll('.tf-tab')].find(el => el.textContent?.includes('子任务'))
    ;(subtasksTab as HTMLElement).click()
    await waitFor(() => doc.querySelectorAll('.tf-item').length >= 2)
    // 验收标签（2026-09-11 语义）：任务级判定面优先 + 子任务降级为过程举证折叠附录
    const reviewTab2 = [...doc.querySelectorAll('.tf-tab')].find(el => el.textContent?.includes('验收'))
    ;(reviewTab2 as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-task-head') !== null)
    expect(doc.querySelector('.tf-task-head')!.textContent).toContain('任务验收')
    // 任务级终检证据卡（引擎自动产出）在前，验证记录默认折叠 → 点行头展开看输出
    await waitFor(() => doc.querySelector('.tf-ev') !== null)
    expect(doc.querySelector('.tf-checkbadge')!.textContent).toContain('自检')
    const verifyHead = doc.querySelector('.tf-ev-verify .tf-ev-sechead') as HTMLElement
    expect(verifyHead).toBeTruthy()
    verifyHead.click()
    await waitFor(() => doc.querySelector('.tf-verify') !== null)
    expect(doc.querySelector('.tf-modal-body')!.textContent).toContain('变更摘要')
    expect(doc.querySelector('.tf-modal-body')!.textContent).toContain('逐条自检')
    expect(doc.querySelectorAll('.tf-verdict').length).toBeGreaterThan(0)
    // 过程举证默认折叠：点开区头 → 手风琴行出现 → 点行展开子任务证据
    expect(doc.querySelector('.tf-proc')).toBeNull()
    const procHead = [...doc.querySelectorAll('button')].find(b => b.textContent?.includes('执行过程举证'))
    expect(procHead).toBeTruthy()
    ;(procHead as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-proc-row') !== null)
    ;(doc.querySelector('.tf-proc-row') as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-proc-item .tf-ev') !== null)
    // 任务级批准按钮（吸底操作栏）
    const approve = [...doc.querySelectorAll('button')].find(b => b.textContent?.includes('验收通过'))
    expect(approve).toBeTruthy()
  })

  it('打回流：批语必填（空批语禁用），填后可点', async () => {
    const doc = dom.window.document
    const rejectBtn = [...doc.querySelectorAll('button')].find(b => b.textContent?.includes('打回'))
    expect(rejectBtn).toBeTruthy()
    expect((rejectBtn as HTMLButtonElement).disabled).toBe(true)
    const textarea = doc.querySelector('.tf-textarea') as HTMLTextAreaElement
    // React 受控组件需要原生 setter 才能触发 onChange（jsdom 直赋值会被 value tracker 吞掉）
    const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
    nativeSetter.call(textarea, '请补充空输入边界测试')
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await waitFor(() => !(rejectBtn as HTMLButtonElement).disabled)
    ;(rejectBtn as HTMLElement).click()
    await waitFor(() => engine.getState().ledger.tasks[0]!.round === 2)
  })

  it('第二轮执行后回到待验收；时间线含打回批语', async () => {
    await waitFor(() => engine.getState().ledger.tasks[0]!.status === 'review')
    const doc = dom.window.document
    const historyTab = [...doc.querySelectorAll('.tf-tab')].find(el => el.textContent?.includes('历史'))
    expect(historyTab).toBeTruthy()
    ;(historyTab as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-timeline') !== null)
    const text = doc.querySelector('.tf-timeline')!.textContent ?? ''
    expect(text).toContain('人')
    expect(text).toContain('批语')
  })

  it('新建抽屉：必填校验与验收留空提示', async () => {
    const doc = dom.window.document
    ;(doc.querySelector('[aria-label="关闭"]') as HTMLElement).click()
    const createBtn = [...doc.querySelectorAll('button')].find(b => b.textContent?.includes('新建任务'))
    ;(createBtn as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-drawer') !== null)
    const submit = [...doc.querySelectorAll('button')].find(b => b.textContent?.includes('创建'))
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    expect(doc.querySelector('.tf-drawer-body')!.textContent).toContain('留空由 AI 补全')
    // 执行模式单选（§7.1b）：默认完全权限
    expect(doc.querySelector('[aria-label="执行模式"]')).toBeTruthy()
    expect([...doc.querySelectorAll('.tf-mode-card')].map(el => el.className).join(',')).toContain('active')
  })

  it('审批模式：通知栏条目 + 抽屉审批卡 + 完全放行后流转待验收', async () => {
    const doc = dom.window.document
    ;(doc.querySelector('[aria-label="关闭"]') as HTMLElement).click()
    // 挂全局通知栏（bundle 出口同款 API）
    const api = (dom.window as unknown as {
      __taskflowTest: { mountNotificationLayer(root: HTMLElement, transport: unknown, options?: { onOpen?: () => void }): () => void }
    }).__taskflowTest
    api.mountNotificationLayer(dom.window.document.body, {
      getState: () => engine.getState(),
      dispatch: (action: unknown) => engine.dispatch(action) as Promise<DispatchResult>,
      subscribe: (onChange: () => void) => engine.subscribe(onChange),
    })

    // 审批模式任务：mock 会话发起提权审批并挂起（每任务首个会话）
    const asked = new Set<string>()
    adapter.executionBehavior = async input => {
      if (!asked.has(input.taskId)) {
        asked.add(input.taskId)
        const decision = await input.approvals.request({
          sessionId: input.sessionId,
          toolName: 'write',
          reason: '（render test）需要写入报告文件',
        })
        if (decision === 'rejected') {
          await input.tools.reportBlocker('提权被拒')
          return
        }
      }
      const result = await input.tools.submitEvidence(buildPassingEvidence(engine.getState().ledger, input.subtaskId))
      if (!result.accepted) throw new Error(result.correction)
    }
    const created = await engine.dispatch({
      type: 'createTask',
      requestId: 'ui-appr',
      title: '审批模式演示任务',
      description: '写入一份演示报告。',
      pins: { executionMode: 'approval' },
    })
    expect(created.ok).toBe(true)
    await waitFor(() => engine.getState().ledger.tasks.find(t => t.id === created.taskId)?.approvals?.some(a => a.status === 'pending') ?? false)

    // 通知栏出现待审批条目；看板卡片出现「待审批」chip
    await waitFor(() => doc.querySelector('.tf-notification-layer .tf-notify') !== null)
    expect(doc.querySelector('.tf-notify')!.textContent).toContain('等待权限审批')
    await waitFor(() => [...doc.querySelectorAll('.tf-chip')].some(el => el.textContent === '待审批'))

    // 打开任务抽屉 → 审批区可见 → 「完全放行」
    const approvalCard = [...doc.querySelectorAll('.tf-card')].find(el => el.textContent?.includes('审批模式演示任务'))
    ;(approvalCard as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-approval') !== null)
    const allowBtn = [...doc.querySelectorAll('.tf-approval button')].find(b => b.textContent?.includes('完全放行'))
    expect(allowBtn).toBeTruthy()
    ;(allowBtn as HTMLElement).click()
    await waitFor(() => engine.getState().ledger.tasks.find(t => t.id === created.taskId)?.status === 'review')
    expect(engine.getState().ledger.tasks.find(t => t.id === created.taskId)?.approvals?.[0]?.status).toBe('elevated')
    // 裁决后通知条目消失
    await waitFor(() => doc.querySelector('.tf-notification-layer .tf-notify') === null)
  })

  it('模型设置浮层：齿轮打开 → 两槽下拉 → 修改即写入引擎设置', async () => {
    const doc = dom.window.document
    // 关闭上一用例遗留的弹窗，回到看板
    const closeDrawer = [...doc.querySelectorAll('.tf-modal-head button')].at(-1) as HTMLElement | undefined
    closeDrawer?.click()
    await waitFor(() => doc.querySelector('.tf-modal') === null)

    // 齿轮打开浮层
    ;(doc.querySelector('[aria-label="模型设置"]') as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-popover') !== null)
    expect(doc.querySelector('.tf-popover')!.textContent).toContain('模型设置')
    // 目录异步到达：「跟随宿主默认」项带出宿主默认值后再断言
    await waitFor(() => doc.querySelector('.tf-popover')!.textContent?.includes('跟随宿主默认（deepseek/deepseek-chat）') ?? false)
    const execSelect = doc.querySelector('select[aria-label="执行 agent · 模型"]') as HTMLSelectElement
    const decompSelect = doc.querySelector('select[aria-label="拆解 agent · 模型"]') as HTMLSelectElement
    expect(execSelect).toBeTruthy()
    expect(decompSelect).toBeTruthy()
    // optgroup 按 provider 分组（两槽 × 2 provider）
    expect(doc.querySelectorAll('.tf-popover optgroup').length).toBe(4)

    // 执行槽选择 ollama 模型（原生 setter 绕过 React value tracker）
    const nativeSelectSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!
    nativeSelectSetter.call(execSelect, 'ollama::qwen3:8b')
    execSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await waitFor(() => engine.getModelSettings().execution?.model === 'qwen3:8b')
    expect(engine.getModelSettings().decompose).toBeNull()
    await waitFor(() => doc.querySelector('.tf-popover')!.textContent?.includes('已保存') ?? false)
    // 拆解槽保持跟随宿主默认
    expect(decompSelect.value).toBe('')

    // Esc 关闭浮层
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => doc.querySelector('.tf-popover') === null)
  })

  it('交付物进验收台（§4.5b）：终检 artifacts 声明 → 预览直接读产物本体', async () => {
    const doc = dom.window.document
    // 关闭上一用例遗留的弹窗，回到看板
    const closeDrawer2 = [...doc.querySelectorAll('.tf-modal-head button')].at(-1) as HTMLElement | undefined
    closeDrawer2?.click()
    await waitFor(() => doc.querySelector('.tf-modal') === null)

    // 布置终检行为：声明一个真实存在的交付物文件；执行行为重置为普通通过流
    // （上一用例遗留的 executionBehavior 会对新任务再次发起提权审批并挂起执行）
    const reportPath = path.join(dir, '交付报告.md')
    await writeFile(reportPath, '# 整理报告\n\n## 一、概览\n\n磁盘 40G 已用 80%。', 'utf8')
    adapter.executionBehavior = async input => {
      const result = await input.tools.submitEvidence(buildPassingEvidence(engine.getState().ledger, input.subtaskId))
      if (!result.accepted) throw new Error(result.correction)
    }
    adapter.finalizeBehavior = async input => {
      const task = engine.getState().ledger.tasks.find(t => t.id === input.taskId)
      const acceptance = task?.contract.acceptance ?? []
      return {
        kind: 'ok' as const,
        output: {
          changesSummary: '（测试）整体交付完成，报告已落盘',
          verification: [{ label: 'ls -l', output: 'exists', passed: true }],
          selfCheck: acceptance.map(a => ({ acceptanceId: a.id, verdict: 'pass' as const, note: '通过' })),
          artifacts: [{ path: reportPath, description: '整理报告 Markdown', howVerified: 'ls -l' }],
        },
      }
    }
    const deliverable = await engine.dispatch({
      type: 'createTask',
      requestId: 'ui-deliverable',
      title: '产出交付物演示任务',
      description: '生成一份 markdown 报告。',
    })
    expect(deliverable.ok).toBe(true)
    await waitFor(() => engine.getState().ledger.tasks.find(t => t.id === deliverable.taskId)?.status === 'review')

    // 打开该任务弹窗 → 验收 tab
    const card = [...doc.querySelectorAll('.tf-card')].find(el => el.textContent?.includes('产出交付物演示任务'))
    ;(card as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-modal') !== null)
    const reviewTab = [...doc.querySelectorAll('.tf-tab')].find(el => el.textContent === '验收 ●' || el.textContent === '验收')
    ;(reviewTab as HTMLElement).click()
    // 交付物区出现（先于判定面的产物本体）
    await waitFor(() => doc.querySelector('[data-testid="deliverables"]') !== null)
    const section = doc.querySelector('[data-testid="deliverables"]')!
    expect(section.textContent).toContain('交付物（1）')
    expect(section.textContent).toContain('整理报告 Markdown')
    // 点「预览」→ 只读预览渲染出 markdown 标题与正文
    const previewBtn = [...section.querySelectorAll('button')].find(b => b.textContent === '预览')
    expect(previewBtn).toBeTruthy()
    ;(previewBtn as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-md') !== null)
    const mdText = doc.querySelector('.tf-artifact-preview')!.textContent ?? ''
    expect(mdText).toContain('整理报告')
    expect(mdText).toContain('磁盘 40G 已用 80%')
    expect(doc.querySelector('.tf-md-h1') !== null).toBe(true)

    // —— 2026-09-12：验收完成后产物第一眼，不用再去验收里翻 ——
    const approveBtn = [...doc.querySelectorAll('button')].find(b => b.textContent?.includes('验收通过'))
    expect(approveBtn).toBeTruthy()
    ;(approveBtn as HTMLElement).click()
    await waitFor(() => engine.getState().ledger.tasks.find(t => t.id === deliverable.taskId)?.status === 'done')
    // 关闭弹窗回看板（approve 后 SSE 刷新看板，卡片节点已被重渲染，需重新查询）
    ;(doc.querySelector('.tf-modal-head button') as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-modal') === null)
    // 等 UI 同步 done（看板卡片状态刷新）后再重开弹窗：默认 tab 的计算基于任务最新状态，
    // 若未同步就重开，会按旧状态（review）落验收页
    await waitFor(() => {
      const c = [...doc.querySelectorAll('.tf-card')].find(el => el.textContent?.includes('产出交付物演示任务'))
      return c?.dataset.status === 'done'
    })
    const doneCard = [...doc.querySelectorAll('.tf-card')].find(el => el.textContent?.includes('产出交付物演示任务'))
    expect(doneCard).toBeTruthy()
    ;(doneCard as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-modal') !== null)
    // 默认 tab 即「产物」页：验收完成（done）不再进验收页，产物独立成页第一眼可见
    await waitFor(() => doc.querySelector('[data-testid="deliverables"]') !== null)
    const activeTab = [...doc.querySelectorAll('.tf-tab')].find(el => el.getAttribute('aria-selected') === 'true')
    expect(activeTab?.textContent).toContain('产物')
    expect(doc.querySelector('[data-testid="deliverables"]')!.textContent).toContain('交付物（1）')
    // 验收页未默认打开（验收页专注验收，done 后不再进）
    expect(doc.querySelector('.tf-task-head')).toBeNull()
  })
})
