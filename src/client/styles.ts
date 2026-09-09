/**
 * 样式表（字符串模块：demo 与 dsh 客户端模块两种形态都可靠注入）。
 *
 * NFR-01：全部颜色走宿主主题变量（--dsw-alias-*），fallback 仅为脱离宿主
 * 的 demo 场景兜底；语义色只用于状态（受阻红/待验收琥珀/完成绿/进行中蓝）。
 * NFR-02：:focus-visible 焦点环、role/aria 由组件负责、prefers-reduced-motion。
 *
 * @module dsh-taskflow/client
 */

export const TASKFLOW_CSS = `
.tf-root { all: initial; display: block; font-family: var(--dsw-alias-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif); font-size: 14px; line-height: 1.5; color: var(--dsw-alias-label-primary, #1f2328); box-sizing: border-box; }
.tf-root *, .tf-root *::before, .tf-root *::after { box-sizing: border-box; }
.tf-root button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
.tf-root :focus-visible { outline: 2px solid var(--dsw-alias-focus-ring, #4c8dff); outline-offset: 2px; border-radius: 4px; }

.tf-board { display: flex; flex-direction: column; height: 100%; background: var(--dsw-alias-bg-canvas, #f6f8fa); }
.tf-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-faint, #d1d9e0); background: var(--dsw-alias-bg-raised, #ffffff); flex-wrap: wrap; }
.tf-title { font-size: 15px; font-weight: 650; margin-right: 8px; }
.tf-search { flex: 1 1 240px; max-width: 360px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-regular, #afb8c1); border-radius: 6px; background: var(--dsw-alias-bg-inset, #f6f8fa); color: inherit; min-width: 0; }
.tf-select { padding: 6px 8px; border: 1px solid var(--dsw-alias-border-regular, #afb8c1); border-radius: 6px; background: var(--dsw-alias-bg-inset, #f6f8fa); color: inherit; }
.tf-btn { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-regular, #afb8c1); background: var(--dsw-alias-bg-raised, #ffffff); min-height: 24px; }
.tf-btn:hover { background: var(--dsw-alias-bg-hover, #eef1f4); }
.tf-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.tf-btn-primary { background: var(--dsw-alias-accent-solid, #1f6feb); border-color: transparent; color: var(--dsw-alias-accent-contrast, #ffffff); }
.tf-btn-primary:hover { background: var(--dsw-alias-accent-solid-hover, #388bfd); }
.tf-btn-danger { color: var(--dsw-alias-status-error-fg, #cf222e); border-color: var(--dsw-alias-status-error-border, #cf222e55); }
.tf-badge { font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.tf-badge-review { background: var(--dsw-alias-status-warning-muted, #fff8c5); color: var(--dsw-alias-status-warning-fg, #9a6700); font-weight: 600; }

.tf-columns { display: grid; grid-auto-flow: column; grid-auto-columns: 280px; gap: 12px; padding: 16px; overflow-x: auto; flex: 1; align-items: start; }
.tf-column { background: var(--dsw-alias-bg-sunken, #eff2f5); border: 1px solid var(--dsw-alias-border-faint, #d1d9e0); border-radius: 10px; padding: 10px; min-height: 200px; display: flex; flex-direction: column; gap: 8px; }
.tf-column-head { display: flex; justify-content: space-between; align-items: center; font-weight: 650; font-size: 13px; padding: 2px 4px; }
.tf-column-count { color: var(--dsw-alias-label-secondary, #59636e); font-variant-numeric: tabular-nums; }
.tf-card { text-align: left; width: 100%; display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-regular, #d1d9e0); background: var(--dsw-alias-bg-raised, #ffffff); transition: transform 120ms ease, box-shadow 120ms ease; }
.tf-card:hover { transform: translateY(-1px); box-shadow: 0 2px 8px var(--dsw-alias-shadow-soft, #1f232814); }
.tf-card-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-card-desc { color: var(--dsw-alias-label-secondary, #59636e); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-card-meta { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--dsw-alias-label-secondary, #59636e); font-variant-numeric: tabular-nums; }
.tf-progress { height: 4px; border-radius: 2px; background: var(--dsw-alias-bg-inset, #d1d9e055); overflow: hidden; }
.tf-progress-bar { height: 100%; background: var(--dsw-alias-accent-solid, #1f6feb); }
.tf-card-blocked { border-color: var(--dsw-alias-status-error-border, #cf222e); }
.tf-card-blocked .tf-card-title::before { content: '⛔ '; }
.tf-card-review-req { border-color: var(--dsw-alias-status-warning-border, #d8a657); }
.tf-chip { font-size: 11.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-faint, #d1d9e0); color: var(--dsw-alias-label-secondary, #59636e); }
.tf-chip-amber { background: var(--dsw-alias-status-warning-muted, #fff8c5); color: var(--dsw-alias-status-warning-fg, #9a6700); border-color: transparent; }

.tf-empty { margin: auto; text-align: center; color: var(--dsw-alias-label-secondary, #59636e); display: flex; flex-direction: column; gap: 12px; align-items: center; padding: 48px 24px; }
.tf-empty-art { font-size: 40px; opacity: 0.8; }
.tf-skeleton { border-radius: 8px; background: linear-gradient(90deg, var(--dsw-alias-bg-inset, #eaeef2) 25%, var(--dsw-alias-bg-sunken, #dfe5ea) 45%, var(--dsw-alias-bg-inset, #eaeef2) 65%); background-size: 200% 100%; animation: tf-shimmer 1.4s ease infinite; min-height: 84px; }
@keyframes tf-shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .tf-root * { animation: none !important; transition: none !important; } }

.tf-banner { display: flex; align-items: center; gap: 8px; padding: 8px 16px; font-size: 13px; background: var(--dsw-alias-status-error-muted, #ffebe9); color: var(--dsw-alias-status-error-fg, #cf222e); }
.tf-banner-warn { background: var(--dsw-alias-status-warning-muted, #fff8c5); color: var(--dsw-alias-status-warning-fg, #9a6700); }
.tf-sse-bar { font-size: 12px; color: var(--dsw-alias-label-secondary, #59636e); }

.tf-overlay { position: fixed; inset: 0; background: var(--dsw-alias-scrim, #00000055); display: flex; justify-content: flex-end; z-index: 60; animation: tf-fade 160ms ease-out; }
@keyframes tf-fade { from { opacity: 0; } }
.tf-drawer { width: min(560px, 92vw); height: 100%; background: var(--dsw-alias-bg-raised, #ffffff); border-left: 1px solid var(--dsw-alias-border-faint, #d1d9e0); display: flex; flex-direction: column; animation: tf-slide 200ms ease-out; overflow: hidden; }
@keyframes tf-slide { from { transform: translateX(24px); opacity: 0; } }
.tf-drawer-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-faint, #d1d9e0); }
.tf-drawer-title { font-size: 15px; font-weight: 650; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-drawer-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.tf-tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--dsw-alias-border-faint, #d1d9e0); }
.tf-tab { padding: 8px 10px; border-bottom: 2px solid transparent; color: var(--dsw-alias-label-secondary, #59636e); min-height: 24px; }
.tf-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary, #1f2328); border-bottom-color: var(--dsw-alias-accent-solid, #1f6feb); font-weight: 600; }
.tf-section { display: flex; flex-direction: column; gap: 6px; }
.tf-section-title { font-size: 12.5px; font-weight: 650; color: var(--dsw-alias-label-secondary, #59636e); text-transform: uppercase; letter-spacing: 0.03em; }
.tf-kv { display: grid; grid-template-columns: 88px 1fr; gap: 4px 10px; font-size: 13px; }
.tf-kv dt { color: var(--dsw-alias-label-secondary, #59636e); }
.tf-list { display: flex; flex-direction: column; gap: 8px; }
.tf-item { border: 1px solid var(--dsw-alias-border-faint, #d1d9e0); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.tf-item-head { display: flex; align-items: center; gap: 8px; }
.tf-item-title { font-weight: 600; flex: 1; }
.tf-ac { display: flex; gap: 8px; font-size: 13px; align-items: baseline; }
.tf-ac-id { font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 12px; color: var(--dsw-alias-label-secondary, #59636e); }
.tf-verdict { font-size: 12px; padding: 1px 7px; border-radius: 999px; white-space: nowrap; }
.tf-verdict-pass { background: var(--dsw-alias-status-success-muted, #dafbe1); color: var(--dsw-alias-status-success-fg, #116329); }
.tf-verdict-partial, .tf-verdict-fail { background: var(--dsw-alias-status-error-muted, #ffebe9); color: var(--dsw-alias-status-error-fg, #cf222e); }
.tf-verify { background: var(--dsw-alias-bg-inset, #f6f8fa); border-radius: 6px; padding: 8px 10px; font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow-y: auto; }
.tf-timeline { display: flex; flex-direction: column; gap: 0; }
.tf-tl-entry { display: grid; grid-template-columns: 108px 1fr; gap: 10px; padding: 7px 0; border-bottom: 1px dashed var(--dsw-alias-border-faint, #d1d9e0); font-size: 13px; }
.tf-tl-time { color: var(--dsw-alias-label-secondary, #59636e); font-variant-numeric: tabular-nums; }
.tf-tl-label { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.tf-tl-actor { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #59636e); border: 1px solid var(--dsw-alias-border-faint, #d1d9e0); border-radius: 999px; padding: 0 6px; }
.tf-tl-detail { color: var(--dsw-alias-label-secondary, #59636e); margin-top: 2px; font-size: 12.5px; white-space: pre-wrap; }
.tf-tl-reject { padding: 6px 8px; border-left: 3px solid var(--dsw-alias-status-error-border, #cf222e); background: var(--dsw-alias-status-error-muted, #ffebe955); border-radius: 4px; }
.tf-form { display: flex; flex-direction: column; gap: 12px; }
.tf-field { display: flex; flex-direction: column; gap: 4px; }
.tf-field label { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #59636e); }
.tf-input, .tf-textarea { padding: 7px 10px; border: 1px solid var(--dsw-alias-border-regular, #afb8c1); border-radius: 6px; background: var(--dsw-alias-bg-inset, #f6f8fa); color: inherit; font: inherit; }
.tf-textarea { min-height: 84px; resize: vertical; }
.tf-actions { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 4px; }
.tf-hint { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #59636e); }
.tf-status-dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }
.tf-dot-blue { background: var(--dsw-alias-accent-solid, #1f6feb); }
.tf-dot-green { background: var(--dsw-alias-status-success-fg, #1a7f37); }
.tf-dot-amber { background: var(--dsw-alias-status-warning-fg, #9a6700); }
.tf-dot-red { background: var(--dsw-alias-status-error-fg, #cf222e); }
.tf-dot-gray { background: var(--dsw-alias-label-secondary, #8c959f); }
.tf-session-link { font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 11.5px; color: var(--dsw-alias-accent-fg, #0969da); }
.tf-count-anim { animation: tf-pulse 360ms ease; }
@keyframes tf-pulse { 50% { transform: scale(1.08); } }
`

let injected = false

/** 注入样式（幂等；data-plugin 标记便于宿主卸载清理）。 */
export function injectStyles(doc: Document = document): void {
  if (injected && doc.querySelector('style[data-plugin="dsh-taskflow"]') !== null) return
  const style = doc.createElement('style')
  style.setAttribute('data-plugin', 'dsh-taskflow')
  style.textContent = TASKFLOW_CSS
  doc.head.append(style)
  injected = true
}
