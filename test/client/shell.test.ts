/**
 * 宿主壳层集成面（jsdom）：会话切换自动退出 + 无服务降级。
 * 看板层是 body 级屏蔽层（z-index 90，压插件面板、低于宿主弹窗），
 * 开合由模块内状态驱动；这里验证 clientApply 的宿主行为契约。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clientApply } from '../../src/client/index.ts'
import type { MinimalClientContext } from '../../src/client/index.ts'

/** 搭一个最小壳层：侧栏（含「新会话」锚点）+ 中栏。 */
function buildShell(): void {
  document.body.innerHTML = ''
  const frame = document.createElement('div')
  frame.id = 'frame'
  const side = document.createElement('div')
  side.className = 'side'
  const newSession = document.createElement('button')
  newSession.className = 'nav-item-test' // 模拟宿主 nav 根类（入口应复刻它）
  newSession.textContent = '新会话'
  side.appendChild(newSession)
  const center = document.createElement('div')
  center.className = 'center'
  frame.append(side, center)
  document.body.appendChild(frame)
}

/** 收集 ctx.effect 登记的清理器（模拟宿主 fiber 卸载）。 */
function fakeEffectCollector(): { effects: Array<() => void>; ctx: Pick<MinimalClientContext, 'effect'> } {
  const effects: Array<() => void> = []
  return {
    effects,
    ctx: {
      effect(fn: () => void | (() => void)): void {
        const disposer = fn()
        if (typeof disposer === 'function') effects.push(disposer)
      },
    },
  }
}

describe('宿主壳层集成面（会话切换 + 降级）', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('会话切换：list feed 可用时订阅，current 变化不抛错且卸载可清理', () => {
    buildShell()
    const listeners: Array<() => void> = []
    let current: string | undefined = 'session-a'
    const sessions = {
      list: {
        getSnapshot: () => ({ current }),
        subscribe(fn: () => void): () => void {
          listeners.push(fn)
          return () => {
            listeners.splice(listeners.indexOf(fn), 1)
          }
        },
      },
    }
    const { ctx, effects } = fakeEffectCollector()
    clientApply({ ...ctx, sessions } as unknown as MinimalClientContext)
    expect(listeners).toHaveLength(1)
    // 切到别的会话：被动关闭看板（当前本就关闭 → no-op），绝不抛错
    current = 'session-b'
    expect(() => listeners[0]!()).not.toThrow()
    // 卸载：订阅解除（此后再来切换事件也无人监听）
    for (const dispose of effects) dispose()
    current = 'session-c'
    expect(listeners).toHaveLength(0)
  })

  it('无 sessions 服务的宿主：apply 照常完成入口安装，且入口复刻宿主 nav 根类（2026-09-12）', () => {
    buildShell()
    const { ctx } = fakeEffectCollector()
    expect(() => clientApply({ ...ctx } as MinimalClientContext)).not.toThrow()
    const entry = document.querySelector('.tf-side-entry')
    expect(entry).toBeTruthy()
    // 外观类与宿主「新会话」一致（尺寸/间距/圆角随宿主 nav-item）
    expect(entry!.classList.contains('nav-item-test')).toBe(true)
    expect(entry!.textContent).toContain('任务看板')
  })

  it('看板打开时点侧栏会话项（含同会话）关闭看板；点中栏不关；Esc 关（2026-09-23）', () => {
    buildShell()
    // jsdom 无布局：给侧栏列一个可被 findSidebarColumn 命中的矩形
    const side = document.querySelector('.side') as HTMLElement
    side.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 280, bottom: 900, width: 280, height: 900, x: 0, y: 0, toJSON: () => side.getBoundingClientRect() }) as DOMRect
    const { ctx, effects } = fakeEffectCollector()
    clientApply({ ...ctx } as unknown as MinimalClientContext)
    const entry = document.querySelector('.tf-side-entry') as HTMLButtonElement

    // 打开看板
    entry.click()
    expect(document.querySelector('.tf-center-layer')).toBeTruthy()
    expect(entry.getAttribute('aria-pressed')).toBe('true')
    // 入口自身再点（「返回会话」）：仍能关闭（捕获排除自身，不与 toggle 打架）
    entry.click()
    expect(document.querySelector('.tf-center-layer')).toBeNull()

    // 复现真机场景：开会板后点侧栏里的**当前会话**（current 不变，feed 不触发）
    entry.click()
    const sessionItem = document.createElement('button')
    sessionItem.textContent = '会话 A'
    side.appendChild(sessionItem)
    sessionItem.click()
    expect(document.querySelector('.tf-center-layer')).toBeNull()
    expect(entry.getAttribute('aria-pressed')).toBe('false')

    // 点中栏（非侧栏）不关
    entry.click()
    document.querySelector('.center')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelector('.tf-center-layer')).toBeTruthy()

    // Esc 兜底关闭
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.tf-center-layer')).toBeNull()

    // 卸载：各清理器（含 click-exit 监听器摘除）执行不抛错
    entry.click()
    expect(() => { for (const dispose of effects) dispose() }).not.toThrow()
  })
})
