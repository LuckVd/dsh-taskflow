/**
 * 客户端出口：框架无关挂载入口 + dsh 客户端模块插件。
 *
 * - {@link mountTaskflow}：挂载到任意 DOM（demo / 宿主壳层皆可）。
 * - dsh client plugin（apply）：
 *   1. 侧栏顶部入口（brand 行之下、「新会话」之上；以 DOM 锚点注入，
 *      因宿主侧栏 shell 不提供该位置的槽位，宽窄栏自适应）；
 *   2. 看板层 = body 级 fixed 层（不注册进 shell.overlay——那是一层
 *      z-index:20 的层叠上下文，而第三方插件的面板层直接挂在 body 上
 *      （z-index ≥ 25），槽位内渲染永远被盖住）。展开时覆盖左栏右侧
 *      整个视口、z-index 90（压过插件工作区层，低于宿主自有弹窗层），
 *      即**屏蔽其他插件的影响**：看板打开期间它们被盖住不可交互，
 *      关闭后原样交还；宿主左侧栏全程可见可点，不是二级页面；
 *   3. 看板层内点击回调不触碰 cordis API（仅翻模块内开关状态）；
 *   4. 会话切换自动退出看板：订阅宿主 sessions.list feed（runner 文档
 *      的核心 face，与具体插件无关），current 变化即被动关闭看板——
 *      只退出视图，绝不拦截切换本身；feed 不可用时静默跳过。
 *
 * @module dsh-taskflow/client
 */

import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { TaskflowApp } from './TaskflowApp.tsx'
import type { TaskflowTransport } from './api.ts'
import { createHttpTransport } from './api.ts'
import { injectStyles } from './styles.ts'

export { TaskflowApp }
export { createHttpTransport, createLocalTransport } from './api.ts'
export type { TaskflowTransport } from './api.ts'
export * from './view.ts'

const roots = new WeakMap<HTMLElement, Root>()

/** 挂载（幂等；返回卸载函数）。onClose 传入时工具栏渲染「✕ 返回会话」。 */
export function mountTaskflow(
  root: HTMLElement,
  transport: TaskflowTransport,
  options?: { onClose?: () => void },
): () => void {
  injectStyles(root.ownerDocument ?? document)
  let reactRoot = roots.get(root)
  if (reactRoot === undefined) {
    reactRoot = createRoot(root)
    roots.set(root, reactRoot)
  }
  reactRoot.render(createElement(TaskflowApp, { transport, onClose: options?.onClose }))
  return () => {
    reactRoot?.unmount()
    roots.delete(root)
  }
}

// —— dsh 客户端模块插件（浏览器半体）——

/** 宿主 sessions.list 订阅面（runner 文档核心 face 的结构子集，防御式访问）。 */
interface SessionListFeed {
  getSnapshot(): { current?: string } | undefined
  subscribe(fn: () => void): () => void
}

/** apply 收到的宿主客户端上下文（结构子集；服务不可用时相关能力静默跳过）。 */
export interface MinimalClientContext {
  /** 宿主核心会话服务（与具体插件无关）；不可用时相关能力静默跳过。 */
  sessions?: { list?: SessionListFeed }
  effect?(fn: () => void | (() => void), name?: string): void
}

export const clientName = 'dsh-taskflow'
export const clientInject = ['sessions']

// —— 看板开合的模块级共享状态（侧栏入口 ↔ body 级看板层）——

let boardOpen = false
let sharedTransport: TaskflowTransport | null = null
let entryButton: HTMLButtonElement | null = null
/** 侧栏列元素（入口锚定时捕获），看板层左边界跟随它的宽度。 */
let sidebarColumn: HTMLElement | null = null

function getTransport(): TaskflowTransport {
  if (sharedTransport === null) sharedTransport = createHttpTransport()
  return sharedTransport
}

/**
 * 看板层（body 级）：展开时覆盖左栏右侧整个视口，z-index 90 压过插件
 * 工作区层（实测约定：插件面板 ≤ 50，宿主自有弹窗 ≥ 100）——看板打开
 * 期间屏蔽其他插件的影响，关闭后原样交还。不感知任何具体插件。
 */
let boardLayer: {
  host: HTMLElement
  unmount: () => void
  observer: ResizeObserver | null
  observed: HTMLElement | null
} | null = null

/** 看板层左边界 = 侧栏宽度；侧栏重锚定/折叠/窄态动画实时跟随。 */
function placeLayer(): void {
  const layer = boardLayer
  if (layer === null) return
  const sidebar = sidebarColumn
  if (sidebar !== layer.observed) {
    if (layer.observed !== null && layer.observer !== null) layer.observer.unobserve(layer.observed)
    layer.observed = sidebar
    if (sidebar !== null && layer.observer !== null) layer.observer.observe(sidebar)
  }
  layer.host.style.left = `${sidebarWidth()}px`
}

function syncLayer(): void {
  if (boardOpen && boardLayer === null) {
    const host = document.createElement('div')
    host.className = 'tf-center-layer'
    document.body.append(host)
    const unmount = mountTaskflow(host, getTransport(), { onClose: () => setBoardOpen(false) })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => placeLayer()) : null
    boardLayer = { host, unmount, observer, observed: null }
    placeLayer()
    window.addEventListener('resize', placeLayer)
  } else if (!boardOpen && boardLayer !== null) {
    boardLayer.unmount()
    boardLayer.host.remove()
    boardLayer.observer?.disconnect()
    window.removeEventListener('resize', placeLayer)
    boardLayer = null
  }
}

function setBoardOpen(open: boolean): void {
  if (boardOpen === open) return
  boardOpen = open
  syncLayer()
  syncEntry()
}

function toggleBoard(): void {
  setBoardOpen(!boardOpen)
}

/** 中栏当前左边界（侧栏宽度）；侧栏未知时退化为 0。 */
function sidebarWidth(): number {
  if (sidebarColumn === null || !sidebarColumn.isConnected) return 0
  return Math.max(0, Math.round(sidebarColumn.getBoundingClientRect().width))
}

function syncEntry(): void {
  const button = entryButton
  if (button === null) return
  button.classList.toggle('tf-side-active', boardOpen)
  button.setAttribute('aria-pressed', boardOpen ? 'true' : 'false')
  const label = button.querySelector('[data-tf-entry-label]')
  if (label !== null) label.textContent = boardOpen ? '返回会话' : '任务看板'
  button.title = boardOpen ? '返回会话' : '任务看板'
}

// —— 侧栏顶部入口（DOM 锚点注入：brand 行之下、「新会话」之上）——

const ENTRY_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="5" height="13" rx="1.5"/><rect x="10" y="3" width="5" height="8" rx="1.5"/><rect x="17" y="3" width="5" height="17" rx="1.5"/></svg>'

/** 从「新会话」按钮向上找侧栏列（贴近左缘、近满高的第一个祖先）。 */
function findSidebarColumn(from: Element): HTMLElement | null {
  let el: HTMLElement | null = from instanceof HTMLElement ? from : from.parentElement
  while (el !== null && el !== document.body) {
    const rect = el.getBoundingClientRect()
    if (
      rect.left <= 8
      && rect.height >= window.innerHeight * 0.7
      && rect.width <= window.innerWidth * 0.5
    ) {
      return el
    }
    el = el.parentElement
  }
  return null
}

/**
 * 在侧栏「新会话」按钮之前注入看板入口。
 *
 * 宿主侧栏 shell 自有 brand 行与「新会话」按钮、不设该位置槽位，故以
 * 文本/aria 锚点定位；侧栏重渲染后自动重新锚定；折叠 rail 形态按锚点
 * 是否带文本自适应图标态；长时间找不到锚点则退化为右下角浮动入口。
 */
function installSidebarEntry(toggle: () => void): () => void {
  let container: HTMLDivElement | null = null
  let observer: MutationObserver | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  let disposed = false

  const findAnchor = (): { parent: Element; before: Element; wide: boolean } | null => {
    for (const button of Array.from(document.querySelectorAll('button'))) {
      const text = (button.textContent ?? '').trim()
      const labelled = button.getAttribute('aria-label') ?? button.title ?? ''
      const isRow = text === '新会话' || text === 'New Session'
      const isRail = labelled === '新会话' || labelled === 'New Session'
      if (!isRow && !isRail) continue
      if (button.parentElement === null) continue
      return { parent: button.parentElement, before: button, wide: isRow }
    }
    return null
  }

  const render = (wide: boolean): void => {
    if (entryButton === null) return
    const icon = `<span class="tf-side-icon" aria-hidden="true">${ENTRY_ICON}</span>`
    entryButton.innerHTML = wide ? `${icon}<span data-tf-entry-label>任务看板</span>` : icon
    entryButton.title = boardOpen ? '返回会话' : '任务看板'
    syncEntry()
  }

  const apply = (found: { parent: Element; before: Element; wide: boolean }): void => {
    if (container === null) {
      container = document.createElement('div')
      entryButton = document.createElement('button')
      entryButton.type = 'button'
      entryButton.className = 'tf-side-row'
      entryButton.setAttribute('aria-pressed', 'false')
      entryButton.addEventListener('click', toggle)
      container.appendChild(entryButton)
    }
    if (container.parentElement !== found.parent || container.nextElementSibling !== found.before) {
      found.parent.insertBefore(container, found.before)
    }
    sidebarColumn = findSidebarColumn(found.before)
    placeLayer() // 看板开着时重锚定：左边界立刻跟随新捕获的侧栏列
    if (observer !== null) observer.disconnect()
    observer = new MutationObserver(() => {
      if (disposed || container === null) return
      if (!container.isConnected || container.nextElementSibling === null) {
        const found = findAnchor()
        if (found !== null) apply(found)
      }
    })
    observer.observe(found.parent, { childList: true })
    entryButton?.classList.toggle('tf-side-rail', !found.wide)
    entryButton?.classList.toggle('tf-side-row', found.wide)
    render(found.wide)
  }

  const tick = (): void => {
    if (disposed) return
    const found = findAnchor()
    if (found !== null) {
      apply(found)
      return
    }
    attempts += 1
    if (attempts > 30) {
      installFloatingEntry(toggle)
      return
    }
    timer = setTimeout(tick, 500)
  }

  tick()
  return () => {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    observer?.disconnect()
    container?.remove()
    entryButton = null
  }
}

/** 找不到侧栏锚点时的保底：右下角浮动入口（同一点击语义）。 */
function installFloatingEntry(toggle: () => void): () => void {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'tf-btn tf-btn-primary tf-floating-entry'
  button.textContent = '任务看板'
  button.addEventListener('click', toggle)
  document.body.append(button)
  return () => {
    button.remove()
    if (entryButton === button) entryButton = null
  }
}

/**
 * 会话切换自动退出看板（宿主核心行为，与具体插件无关）：订阅宿主
 * sessions.list feed，current 变化（切到别的会话 / 会话关闭）即被动关闭
 * 看板——只退出视图，绝不拦截切换本身；回调里零 cordis 调用。
 * feed 不可用时静默跳过（不挂不崩）。
 */
function watchSessionSwitch(ctx: MinimalClientContext): () => void {
  const list = ctx.sessions?.list
  if (list === undefined) return () => {}
  let current: string | undefined
  try {
    current = list.getSnapshot()?.current
  } catch {
    return () => {}
  }
  let unsubscribe: () => void = () => {}
  try {
    unsubscribe = list.subscribe(() => {
      let next: string | undefined
      try {
        next = list.getSnapshot()?.current
      } catch {
        return
      }
      if (next === current) return
      current = next
      setBoardOpen(false)
    })
  } catch {
    return () => {}
  }
  return unsubscribe
}

/** dsh 客户端模块 apply：侧栏顶部入口 + body 级看板层 + 会话切换自动退出。 */
export function clientApply(ctx: MinimalClientContext): void {
  injectStyles()
  const cleanupEntry = installSidebarEntry(toggleBoard)
  const disposeSessionWatch = watchSessionSwitch(ctx)
  ctx.effect?.(() => () => disposeSessionWatch(), 'taskflow.session-watch')
  ctx.effect?.(() => {
    return () => {
      cleanupEntry()
      setBoardOpen(false)
    }
  }, 'taskflow.entry-cleanup')
}

// —— dsh 客户端模块约定出口（window.__ModuleLoader__.load 的 factory 返回本对象）——
// 兼容具名导出形态：宿主模块系统要求 bundle exports 即客户端插件（name/inject/apply）。
export const name = clientName
export const inject = clientInject
export function apply(ctx: MinimalClientContext): void {
  clientApply(ctx)
}
