/**
 * 客户端出口：框架无关挂载入口 + dsh 客户端模块插件。
 *
 * - {@link mountTaskflow}：挂载到任意 DOM（渲染冒烟 / 宿主壳层皆可）。
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
import { NotificationBar } from './NotificationBar.tsx'
import type { TaskflowTransport } from './api.ts'
import { createHttpTransport } from './api.ts'
import { injectStyles } from './styles.ts'
import { installBrowserNotifications } from './notifications.ts'
import { setBoardFocus } from './focus.ts'

export { TaskflowApp }
export { NotificationBar }
export { createHttpTransport } from './api.ts'
export type { TaskflowTransport } from './api.ts'
export * from './view.ts'
export { setBoardFocus, clearBoardFocus, getBoardFocus, subscribeBoardFocus } from './focus.ts'
export type { BoardFocus } from './focus.ts'
export {
  browserNotifyPref,
  browserNotifyPermission,
  browserNotifySupported,
  installBrowserNotifications,
  requestBrowserNotifyPermission,
  setBrowserNotifyPref,
} from './notifications.ts'

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

// —— 全局通知栏（body 级，z-index 95：看板 90 之上、宿主自有弹窗 100 之下）——

/**
 * 全局通知栏挂载：待裁决审批的常驻条目 + 「去处理」跳转。
 * 容器 click-through、条目自管 pointer-events；纯 DOM + 既有 HTTP/SSE，
 * 对宿主与其他插件零感知（通用性红线）。幂等由调用方保证。
 */
export function mountNotificationLayer(
  mountRoot: HTMLElement,
  transport: TaskflowTransport,
  options?: { onOpen?: () => void },
): () => void {
  injectStyles(mountRoot.ownerDocument ?? document)
  const host = document.createElement('div')
  host.className = 'tf-notification-layer'
  const root = createRoot(host)
  root.render(createElement(NotificationBar, {
    transport,
    onOpen: options?.onOpen ?? (() => {}),
  }))
  mountRoot.append(host)
  return () => {
    root.unmount()
    host.remove()
  }
}

function syncEntry(): void {
  const button = entryButton
  if (button === null) return
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
 *
 * 2026-09-12：入口按钮 className **复刻宿主「新会话」的根类**（取首个 token，
 * 组件级唯一），尺寸/间距/圆角/字体与宿主 nav 完全一致（含 rail 折叠态）；
 * .tf-side-entry 仅为兜底与激活高亮（aria-pressed 自管）。
 */
function installSidebarEntry(toggle: () => void): () => void {
  let container: HTMLDivElement | null = null
  let observer: MutationObserver | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  let disposed = false

  const findAnchor = (): { parent: Element; before: Element; wide: boolean; hostClass: string } | null => {
    for (const button of Array.from(document.querySelectorAll('button'))) {
      const text = (button.textContent ?? '').trim()
      const labelled = button.getAttribute('aria-label') ?? button.title ?? ''
      const isRow = text === '新会话' || text === 'New Session'
      const isRail = labelled === '新会话' || labelled === 'New Session'
      if (!isRow && !isRail) continue
      if (button.parentElement === null) continue
      const first = (button.className.trim().split(/\s+/)[0] ?? '').trim()
      return { parent: button.parentElement, before: button, wide: isRow, hostClass: first }
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

  const apply = (found: { parent: Element; before: Element; wide: boolean; hostClass: string }): void => {
    if (container === null) {
      container = document.createElement('div')
      entryButton = document.createElement('button')
      entryButton.type = 'button'
      entryButton.setAttribute('aria-pressed', 'false')
      entryButton.addEventListener('click', toggle)
      container.appendChild(entryButton)
    }
    if (container.parentElement !== found.parent || container.nextElementSibling !== found.before) {
      found.parent.insertBefore(container, found.before)
    }
    // 复刻宿主 nav 根类（外观完全一致）；tf-side-entry 只做行为与兜底
    if (entryButton !== null) {
      entryButton.className = found.hostClass === '' ? 'tf-side-entry' : `tf-side-entry ${found.hostClass}`
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
 * 同会话点击也能退出看板（2026-09-23 真机反馈修复）：看板打开期间，用户
 * 点侧栏里**当前已激活**的原生会话，宿主 sessions.list 的 current 不变
 * （宿主视为 no-op），watchSessionSwitch 的「current 变化才退出」永远不会
 * 触发——看板层继续盖住原会话，表现为「点不回去」。
 *
 * 修法：捕获阶段监听文档 click，看板开着且点击落在侧栏列内即被动关闭
 * 看板——只退视图，不 stopPropagation、不 preventDefault，宿主自己的
 * 会话选中逻辑照常执行（含切到别的会话，那条路径仍由 feed 兜底）。
 *
 * 性能：两个文档级监听器常驻，但看板关着时首行布尔短路返回；命中判断
 * 是一次 contains()（O(祖先深度)）。无轮询、无新增 observer、无重排。
 * Esc 兜底关闭走同一开合路径。
 */
function installSidebarClickExit(): () => void {
  const onClick = (ev: MouseEvent): void => {
    if (!boardOpen) return
    const target = ev.target
    if (!(target instanceof Node)) return
    // 入口按钮自身也在侧栏列内：它的「返回会话」toggle 走自己的 click
    // 处理器，这里跳过，否则捕获阶段先关闭、target 阶段又 toggle 重开
    if (entryButton !== null && entryButton.contains(target)) return
    const sidebar = sidebarColumn !== null && sidebarColumn.isConnected ? sidebarColumn : null
    if (sidebar === null || !sidebar.contains(target)) return
    setBoardOpen(false)
  }
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (boardOpen && ev.key === 'Escape') setBoardOpen(false)
  }
  document.addEventListener('click', onClick, { capture: true, passive: true })
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
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

/** dsh 客户端模块 apply：侧栏顶部入口 + body 级看板层 + 全局通知栏 + 会话切换自动退出。 */
export function clientApply(ctx: MinimalClientContext): void {
  injectStyles()
  const cleanupEntry = installSidebarEntry(toggleBoard)
  const disposeNotify = mountNotificationLayer(document.body, getTransport(), { onOpen: () => setBoardOpen(true) })
  // FR-16 浏览器通知：shell 级常驻（看板关着也要能响）；点击通知打开看板并定位任务
  const disposeBrowserNotify = installBrowserNotifications(getTransport(), focus => {
    setBoardFocus({ taskId: focus.taskId, ...(focus.approvalId !== undefined ? { approvalId: focus.approvalId } : {}) })
    setBoardOpen(true)
  })
  const disposeSessionWatch = watchSessionSwitch(ctx)
  const disposeClickExit = installSidebarClickExit()
  ctx.effect?.(() => () => disposeSessionWatch(), 'taskflow.session-watch')
  ctx.effect?.(() => () => disposeClickExit(), 'taskflow.sidebar-click-exit')
  ctx.effect?.(() => {
    return () => {
      cleanupEntry()
      disposeNotify()
      disposeBrowserNotify()
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
