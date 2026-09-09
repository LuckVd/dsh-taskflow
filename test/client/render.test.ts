/**
 * 客户端渲染冒烟（jsdom）：真实构建产物 dist/client.demo.js + 真实引擎。
 * 验证：挂载、看板四列、卡片、抽屉五区、验收页证据、打回流、三态 aria。
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_CONFIG, TaskflowEngine } from '../../src/host/engine.ts'
import type { DispatchResult } from '../../src/host/engine.ts'
import { LedgerStore } from '../../src/host/ledger.ts'
import { MockSessionAdapter } from '../../src/host/mock/session-adapter.ts'
import { handleTaskflowRequest } from '../../src/host/http.ts'
import { cleanup, tempDir, waitFor } from '../helpers.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '../../dist/client.demo.js')

describe.skipIf(!existsSync(bundlePath))('客户端渲染冒烟（dist 产物 + 真实引擎）', () => {
  let dom: JSDOM
  let engine: TaskflowEngine
  let dir: string
  let unmount: (() => void) | undefined

  beforeAll(async () => {
    dir = await tempDir('taskflow-ui-')
    const box: { engine?: TaskflowEngine } = {}
    const adapter = new MockSessionAdapter({ getLedger: () => box.engine!.getState().ledger })
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

    window.eval(readFileSync(bundlePath, 'utf8') + ';window.__taskflowDemo = __taskflowDemo;')
    const api = (window as unknown as { __taskflowDemo: { mountTaskflow(root: HTMLElement, transport: unknown): () => void } }).__taskflowDemo
    expect(api).toBeTruthy()
    unmount = api.mountTaskflow(window.document.getElementById('root')!, {
      getState: () => engine.getState(),
      dispatch: (action: unknown) => engine.dispatch(action) as Promise<DispatchResult>,
      subscribe: (onChange: () => void) => engine.subscribe(onChange),
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

  it('详情抽屉：五区标签 + 合同 + 子任务 + 证据报告卡', async () => {
    const doc = dom.window.document
    ;(doc.querySelector('.tf-card') as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-drawer') !== null)
    const tabs = [...doc.querySelectorAll('.tf-tab')].map(el => el.textContent)
    expect(tabs.join(',')).toContain('合同')
    expect(tabs.join(',')).toContain('子任务')
    expect(tabs.join(',')).toContain('验收')
    expect(tabs.join(',')).toContain('历史')
    expect(tabs.join(',')).toContain('拆解记录')

    // 子任务标签
    ;(doc.querySelector('.tf-tab:nth-child(2)') as HTMLElement).click()
    await waitFor(() => doc.querySelectorAll('.tf-item').length >= 2)
    // 验收标签：证据三要素 + 逐条对照
    ;(doc.querySelector('.tf-tab:nth-child(3)') as HTMLElement).click()
    await waitFor(() => doc.querySelector('.tf-verify') !== null)
    expect(doc.querySelector('.tf-drawer-body')!.textContent).toContain('变更摘要')
    expect(doc.querySelector('.tf-drawer-body')!.textContent).toContain('逐条自检')
    expect(doc.querySelectorAll('.tf-verdict').length).toBeGreaterThan(0)
    // 批准按钮（任务级）
    const approve = [...doc.querySelectorAll('button')].find(b => b.textContent?.includes('批准'))
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
    ;(doc.querySelector('.tf-tab:nth-child(4)') as HTMLElement).click()
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
  })
})
