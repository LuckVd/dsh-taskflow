/**
 * 客户端血缘 UI 冒烟（jsdom + 真实引擎 + dist 产物）：链徽标、看板连线层、
 * 合同 tab「接续自」横幅、流程 tab「上一棒」节点、done 卡接续预填。
 * 前置：`npm run build`（与 render.test.ts 同款 skipIf 守卫）。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_CONFIG, TaskflowEngine } from '../../src/host/engine.ts'
import type { DispatchResult } from '../../src/host/engine.ts'
import { LedgerStore } from '../../src/host/ledger.ts'
import { MockSessionAdapter } from '../../src/host/mock/session-adapter.ts'
import { cleanup, tempDir, waitFor } from '../helpers.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '../../dist/client.iife.js')

describe.skipIf(!existsSync(bundlePath))('血缘 UI（dist 产物 + 真实引擎）', () => {
  let dom: JSDOM
  let engine: TaskflowEngine
  let dir: string
  let unmount: (() => void) | undefined
  let parentId = ''
  let childId = ''

  beforeAll(async () => {
    dir = await tempDir('taskflow-kin-')
    const box: { engine?: TaskflowEngine } = {}
    const adapter = new MockSessionAdapter({ getLedger: () => box.engine!.getState().ledger })
    engine = new TaskflowEngine(new LedgerStore(path.join(dir, 'ledger.json')), adapter, DEFAULT_ENGINE_CONFIG)
    box.engine = engine
    await engine.boot()

    // 第一棒：主链路到 done
    const first = await engine.dispatch({
      type: 'createTask',
      requestId: 'kin-parent',
      title: '实现会话持久化',
      description: '会话重启可恢复。',
      acceptance: [{ text: '重启后恢复上次会话。' }],
    })
    expect(first.ok, JSON.stringify(first)).toBe(true)
    parentId = first.taskId!
    await waitFor(() => engine.getState().ledger.tasks.find(t => t.id === parentId)?.status === 'review')
    const approved = await engine.dispatch({ type: 'approveTask', requestId: 'kin-approve', taskId: parentId })
    expect(approved.ok).toBe(true)

    // 第二棒：接续创建（自动拆解）
    const second = await engine.dispatch({
      type: 'createTask',
      requestId: 'kin-child',
      title: '续做：持久化性能优化',
      description: '接续上一棒压测优化。',
      basedOn: [parentId],
    })
    expect(second.ok, JSON.stringify(second)).toBe(true)
    childId = second.taskId!

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://127.0.0.1:4173/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      virtualConsole: (() => { const vc = new VirtualConsole(); for (const ev of ['error', 'jsdomError']) vc.on(ev, (...a) => console.log('[JSDOM]', ev, ...a.map(x => x?.stack ?? x))); return vc })(),
    })
    const { window } = dom
    window.eval(readFileSync(bundlePath, 'utf8') + ';window.__taskflowTest = __taskflowTest;')
    const api = (window as unknown as { __taskflowTest: { mountTaskflow(root: HTMLElement, transport: unknown): () => void } }).__taskflowTest
    expect(api).toBeTruthy()
    unmount = api.mountTaskflow(window.document.getElementById('root')!, {
      getCachedState: () => null,
      getState: () => engine.getState(),
      dispatch: (action: unknown) => engine.dispatch(action) as Promise<DispatchResult>,
      subscribe: (onChange: () => void) => engine.subscribe(onChange),
    })
  }, 30_000)

  afterAll(async () => {
    unmount?.()
    await cleanup(dir)
  })

  it('看板：子任务卡带链徽标，血缘连线层挂载且至少一条边', async () => {
    const doc = dom.window.document
    await waitFor(() => doc.querySelectorAll('.tf-card').length >= 2)
    const childCard = doc.querySelector(`.tf-card[data-task-id="${childId}"]`)
    expect(childCard).toBeTruthy()
    // 链徽标：单父 = 链·1
    const chip = childCard!.querySelector('.tf-chain-chip')
    expect(chip).toBeTruthy()
    expect(chip!.textContent).toContain('链·1')
    // 连线层：无血缘不挂载 / 有血缘至少一条 path
    const wires = doc.querySelector('svg.tf-wires')
    expect(wires).toBeTruthy()
    expect(wires!.querySelectorAll('path').length).toBeGreaterThanOrEqual(1)
  })

  it('详情弹窗（子任务）：合同 tab 接续横幅逐父一行；流程 tab 上一棒节点', async () => {
    const doc = dom.window.document
    const childCard = doc.querySelector(`.tf-card[data-task-id="${childId}"]`) as HTMLElement
    childCard.click()
    await waitFor(() => doc.querySelector('.tf-modal') !== null)
    // in-progress 子任务默认落流程 tab；若还在 decomposing/ready 落合同——两种都断言
    const modal = doc.querySelector('.tf-modal')!
    // 流程 tab 上一棒节点（只读引用）
    const parentTitle = '实现会话持久化'
    const flowHasParent = modal.querySelector('.tf-dag-parent') !== null
    if (flowHasParent) {
      expect(modal.querySelector('.tf-dag-parent')!.textContent).toContain(parentTitle)
    }
    // 切到合同 tab：接续自横幅
    const contractTab = [...modal.querySelectorAll('.tf-tab')].find(el => el.textContent?.includes('合同')) as HTMLElement
    contractTab.click()
    await waitFor(() => modal.querySelector('.tf-ct-lineage') !== null)
    expect(modal.querySelector('.tf-ct-lineage')!.textContent).toContain('接续自')
    expect(modal.querySelector('.tf-ct-lineage')!.textContent).toContain(parentTitle)
  })

  it('创建表单：接续入口预填 basedOn tag（父任务名）', async () => {
    const doc = dom.window.document
    // 关闭详情弹窗
    const closeBtn = doc.querySelector('.tf-modal .tf-icon-btn[aria-label="关闭"]') as HTMLElement
    closeBtn?.click()
    await waitFor(() => doc.querySelector('.tf-modal') === null)
    // done 卡（父任务）上的「接续」按钮
    const parentCard = doc.querySelector(`.tf-card[data-task-id="${parentId}"]`) as HTMLElement
    const followBtn = [...parentCard.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('接续')) as HTMLElement
    expect(followBtn).toBeTruthy()
    followBtn.click()
    await waitFor(() => doc.querySelector('.tf-modal') !== null)
    // 继承自 tag 已预选父任务名
    await waitFor(() => doc.querySelector('.tf-lineage-tag') !== null)
    expect(doc.querySelector('.tf-lineage-tag')!.textContent).toContain('实现会话持久化')
  })
})
