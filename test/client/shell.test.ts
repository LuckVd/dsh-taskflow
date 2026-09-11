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

  it('无 sessions 服务的宿主：apply 照常完成入口安装', () => {
    buildShell()
    const { ctx } = fakeEffectCollector()
    expect(() => clientApply({ ...ctx } as MinimalClientContext)).not.toThrow()
    expect(document.querySelector('.tf-side-row')).toBeTruthy()
  })
})
