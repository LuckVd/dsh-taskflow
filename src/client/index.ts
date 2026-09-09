/**
 * 客户端出口：框架无关挂载入口 + dsh 客户端模块插件。
 *
 * - {@link mountTaskflow}：挂载到任意 DOM（demo / 宿主壳层皆可）。
 * - dsh client plugin（apply）：把看板注册进宿主 shell.overlay 槽位 +
 *   侧栏入口；槽位服务不可用时优雅降级为全屏浮层。
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

/** 挂载（幂等；返回卸载函数）。 */
export function mountTaskflow(root: HTMLElement, transport: TaskflowTransport): () => void {
  injectStyles(root.ownerDocument ?? document)
  let reactRoot = roots.get(root)
  if (reactRoot === undefined) {
    reactRoot = createRoot(root)
    roots.set(root, reactRoot)
  }
  reactRoot.render(createElement(TaskflowApp, { transport }))
  return () => {
    reactRoot?.unmount()
    roots.delete(root)
  }
}

// —— dsh 客户端模块插件（浏览器半体）——

/** 槽位服务最小结构类型（宿主 ui-slots；npm 版本漂移下防御式访问）。 */
interface SlotsService {
  register(
    seat: { name: string; key?: string; id?: string; title?: string },
    component: (props: Record<string, unknown>) => unknown,
  ): () => void
}

interface MinimalClientContext {
  slots?: SlotsService
  effect?(fn: () => void | (() => void)): void
}

export const clientName = 'dsh-taskflow'
export const clientInject = ['slots']

/** 全屏看板面板（注册进 shell.overlay 槽位）。 */
function TaskflowPanel(): unknown {
  return createElement(TaskflowApp, { transport: createHttpTransport() })
}

/** dsh 客户端模块 apply：槽位可用走 shell.overlay + 侧栏入口，否则降级浮层。 */
export function clientApply(ctx: MinimalClientContext): void {
  injectStyles()
  if (ctx.slots?.register !== undefined) {
    try {
      ctx.slots?.register({ name: 'shell.overlay', id: 'dsh-taskflow-board' }, TaskflowPanel)
      return
    } catch {
      // 注册失败（槽位形态漂移）→ 降级
    }
  }
  // 降级：直接挂一个可关闭的浮层（独立使用/宿主无槽位服务）
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;z-index:50;display:none'
  document.body.append(host)
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'tf-btn'
  toggle.textContent = '🗂️ 任务看板'
  toggle.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:51;padding:8px 14px;border-radius:8px;border:1px solid #888;background:#fff;cursor:pointer'
  toggle.addEventListener('click', () => {
    const visible = host.style.display !== 'none'
    host.style.display = visible ? 'none' : 'block'
    if (!visible) mountTaskflow(host, createHttpTransport())
  })
  document.body.append(toggle)
  ctx.effect?.(() => {
    host.remove()
    toggle.remove()
  })
}

// —— dsh 客户端模块约定出口（window.__ModuleLoader__.load 的 factory 返回本对象）——
// 兼容具名导出形态：宿主模块系统要求 bundle exports 即客户端插件（name/inject/apply）。
export const name = clientName
export const inject = clientInject
export function apply(ctx: MinimalClientContext): void {
  clientApply(ctx)
}
