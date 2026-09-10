/**
 * 样式表（字符串模块：demo 与 dsh 宿主两种形态都可靠注入）。
 *
 * 视觉方案：design/ui-preview.html 方案三「分栏」（2026-09 评审选定）——
 * 淡灰列容器 + 白卡 + 卡片左侧状态色条 + 状态点语言；工具栏与按钮遵循
 * 预览稿「无灰描边盒」原则（仅信息蓝填充 / 幽灵两形态）。
 *
 * 设计语言对齐宿主主题（token 集 = dsh 0.1.2-rc.1 dsh-client-ui-theme 实际
 * 存在的变量，深浅色与皮肤自动适配）：bg-base/bg-layer-2 分层、border-l1/2/3、
 * state-*-primary/-secondary/-tertiary/-label 语义色、button-info-fill 主按钮、
 * shadow-lv1/2/3 阴影。fallback 仅为脱离宿主的 demo 兜底。
 * NFR-01/NFR-02：:focus-visible 焦点环、prefers-reduced-motion、120ms 动效。
 *
 * @module dsh-taskflow/client
 */

const V = {
  bgBase: "var(--dsw-alias-bg-base, #f6f8fa)",
  bgLayer2: "var(--dsw-alias-bg-layer-2, #eff2f5)",
  bgHover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))",
  bgHoverDanger: "var(--dsw-alias-interactive-bg-hover-danger, rgba(207,34,46,0.08))",
  mask: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))",
  borderL1: "var(--dsw-alias-border-l1, #d8dee4)",
  borderL2: "var(--dsw-alias-border-l2, #c7ced6)",
  borderL3: "var(--dsw-alias-border-l3, #afb8c1)",
  label: "var(--dsw-alias-label-primary, #1f2328)",
  label2: "var(--dsw-alias-label-secondary, #59636e)",
  label3: "var(--dsw-alias-label-tertiary, #8c959f)",
  caption: "var(--dsw-alias-label-caption, #8c959f)",
  onPrimary: "var(--dsw-alias-label-primary-foreground, #ffffff)",
  business: "var(--dsw-alias-state-business-primary, #1f6feb)",
  warn: "var(--dsw-alias-state-warn-primary, #9a6700)",
  success: "var(--dsw-alias-state-success-primary, #1a7f37)",
  error: "var(--dsw-alias-state-error-primary, #cf222e)",
  errorSecondary: "var(--dsw-alias-state-error-secondary, #cf222e)",
  warnLabel: "var(--dsw-alias-state-warn-label, #9a6700)",
  businessTertiary: "var(--dsw-alias-state-business-tertiary, rgba(31,111,235,0.10))",
  successTertiary: "var(--dsw-alias-state-success-tertiary, rgba(26,127,55,0.10))",
  warnTertiary: "var(--dsw-alias-state-warn-tertiary, rgba(154,103,0,0.10))",
  errorTertiary: "var(--dsw-alias-state-error-tertiary, rgba(207,34,46,0.10))",
  inkGreen: "var(--ink-green, var(--dsw-alias-state-success-primary, #17a34c))",
  navActive: "var(--dsw-specific-nav-active, rgba(128,128,128,0.14))",
  navAccent: "var(--dsw-specific-nav-active-accent, var(--dsw-alias-button-info-fill, #1f6feb))",
  btnInfo: "var(--dsw-alias-button-info-fill, #1f6feb)",
  btnInfoHover: "var(--dsw-alias-button-info-hover, #388bfd)",
  shadow1: "var(--dsw-shadow-lv1, 0 1px 4px rgba(31,35,40,0.10))",
  shadow2: "var(--dsw-shadow-lv2, 0 4px 12px rgba(31,35,40,0.14))",
  shadow3: "var(--dsw-shadow-lv3, 0 8px 28px rgba(31,35,40,0.20))",
  codeFont: "var(--dsw-font-markdown-code-block-small, var(--dsw-font-family, ui-monospace, monospace))",
  font: "var(--dsw-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif)",
}

export const TASKFLOW_CSS = `
.tf-root { all: initial; display: block; font-family: ${V.font}; font-size: 14px; line-height: 1.5; color: ${V.label}; box-sizing: border-box; }
.tf-root *, .tf-root *::before, .tf-root *::after { box-sizing: border-box; }
/* :where() 零特异性 —— reset 不得压过组件类（.tf-card 等）自己的 padding */
.tf-root :where(button) { font: inherit; color: inherit; background: none; border: none; cursor: pointer; padding: 0; }
.tf-root :where(input, select, textarea) { font-family: inherit; }
.tf-root :focus-visible { outline: 2px solid ${V.business}; outline-offset: 2px; border-radius: 6px; }

/* —— 看板框架（工具栏 + 分栏列区）—— */
.tf-board { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; background: ${V.bgBase}; color: ${V.label}; }
.tf-toolbar { display: flex; align-items: center; gap: 12px; flex: none; flex-wrap: wrap; padding: 12px 20px; border-bottom: 1px solid ${V.borderL1}; }
.tf-title { font-size: 15px; font-weight: 700; white-space: nowrap; margin-right: 4px; }
.tf-search { display: flex; align-items: center; gap: 6px; flex: 0 1 240px; min-width: 160px; height: 30px; padding: 0 10px; border-radius: 8px; background: ${V.bgLayer2}; color: ${V.label3}; transition: background-color 120ms ease; }
.tf-search:hover { background: ${V.bgHover}; }
.tf-search svg { flex: none; }
.tf-search input { flex: 1; min-width: 0; border: none; outline: none; background: none; font: inherit; font-size: 13px; color: ${V.label}; }
.tf-search input::placeholder { color: ${V.label3}; }
.tf-toolbar .tf-select { height: 30px; padding: 0 4px 0 8px; color: ${V.label2}; background: transparent; border-color: transparent; }
.tf-toolbar .tf-select:hover { background: ${V.bgHover}; color: ${V.label}; }

/* —— 按钮（两种形态：信息蓝填充 / 幽灵，无灰描边盒）—— */
.tf-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 14px; font-size: 13px; font-weight: 600; color: ${V.label2}; background: transparent; border: none; border-radius: 8px; white-space: nowrap; transition: background-color 120ms ease, color 120ms ease; }
.tf-btn:hover:not(:disabled) { background: ${V.bgHover}; color: ${V.label}; }
.tf-btn:disabled { opacity: 0.45; cursor: default; }
.tf-btn-primary { color: ${V.onPrimary}; background: ${V.btnInfo}; }
.tf-btn-primary:hover:not(:disabled) { background: ${V.btnInfoHover}; color: ${V.onPrimary}; }
.tf-btn-primary:disabled { opacity: 0.5; cursor: default; }
.tf-btn-danger { color: ${V.errorSecondary}; }
.tf-btn-danger:hover:not(:disabled) { background: ${V.bgHoverDanger}; color: ${V.errorSecondary}; }
.tf-link-btn { height: auto; padding: 0; font-size: 12.5px; font-weight: 500; color: ${V.business}; background: none; border: none; }
.tf-link-btn:hover:not(:disabled) { background: none; text-decoration: underline; }
.tf-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border-radius: 6px; color: ${V.label3}; }
.tf-icon-btn:hover:not(:disabled) { background: ${V.bgHover}; color: ${V.label}; }

.tf-badge { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tf-badge-review { margin-left: auto; color: ${V.warnLabel}; background: ${V.warnTertiary}; }
.tf-badge-review i { width: 6px; height: 6px; border-radius: 50%; background: ${V.warn}; flex: none; }

/* —— 列（方案三：淡灰圆角栏容器）—— */
.tf-columns { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(250px, 1fr); gap: 12px; flex: 1; min-height: 0; overflow-x: auto; overflow-y: hidden; padding: 16px 20px 12px; scrollbar-color: ${V.borderL3} ${V.bgHover}; scrollbar-width: thin; }
.tf-columns::-webkit-scrollbar { height: 10px; }
.tf-columns::-webkit-scrollbar-track { background: ${V.bgHover}; border-radius: 999px; }
.tf-columns::-webkit-scrollbar-thumb { background: ${V.borderL3}; background-clip: content-box; border: 2px solid transparent; border-radius: 999px; }
.tf-column { display: flex; flex-direction: column; min-height: 0; background: ${V.bgLayer2}; border: 1px solid ${V.borderL1}; border-radius: 12px; padding: 6px 8px 8px; overflow: hidden; }
.tf-column-head { display: flex; align-items: center; gap: 8px; padding: 8px 6px; flex: none; font-size: 13px; font-weight: 600; color: ${V.label2}; }
.tf-column-head > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-column-count { flex: none; font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 999px; color: ${V.label3}; background: ${V.bgHover}; font-variant-numeric: tabular-nums; }
.tf-column-count.hot { color: ${V.warnLabel}; background: ${V.warnTertiary}; }
.tf-column-cards { display: flex; flex-direction: column; gap: 8px; padding: 0 2px 2px; overflow-y: auto; flex: 1; min-height: 0; scrollbar-width: thin; scrollbar-color: ${V.borderL3} transparent; }
.tf-column-empty { padding: 18px 4px; font-size: 12px; color: ${V.caption}; }
.tf-columns .tf-card { flex: none; }

/* —— 卡片（白卡 + 左侧状态色条）—— */
.tf-card { position: relative; text-align: left; width: 100%; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 10px 15px; border-radius: 8px; border: none; background: ${V.bgBase}; color: ${V.label}; box-shadow: ${V.shadow1}; transition: box-shadow 120ms ease; }
.tf-card:hover { box-shadow: ${V.shadow2}; }
.tf-card::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 999px; background: ${V.caption}; opacity: 0.6; }
.tf-card[data-status='decomposing']::before, .tf-card[data-status='in-progress']::before { background: ${V.warn}; opacity: 1; }
.tf-card[data-status='review']::before { background: ${V.business}; opacity: 1; }
.tf-card[data-status='blocked']::before { background: ${V.error}; opacity: 1; }
.tf-card[data-status='done']::before { background: ${V.success}; opacity: 1; }
.tf-card-title { font-size: 13.5px; font-weight: 600; line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.tf-card-desc { font-size: 12px; line-height: 1.45; color: ${V.label2}; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.tf-card-meta { display: flex; align-items: center; gap: 6px; font-size: 12px; color: ${V.label2}; flex-wrap: wrap; min-height: 18px; }
.tf-time { margin-left: auto; font-size: 11px; color: ${V.label3}; font-variant-numeric: tabular-nums; }
.tf-meta-strong { color: ${V.label}; font-weight: 500; }
.tf-status-tag { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; color: ${V.label2}; white-space: nowrap; }
.tf-status-tag i { width: 6px; height: 6px; border-radius: 50%; background: ${V.label3}; flex: none; }
.tf-status-tag[data-status='in-progress'] i, .tf-status-tag[data-status='decomposing'] i { background: ${V.warn}; }
.tf-status-tag[data-status='review'] i { background: ${V.business}; }
.tf-status-tag[data-status='blocked'] i, .tf-status-tag[data-status='rejected'] i { background: ${V.errorSecondary}; }
.tf-status-tag[data-status='done'] i { background: ${V.inkGreen}; }
.tf-progress { height: 4px; border-radius: 999px; background: ${V.bgLayer2}; overflow: hidden; }
.tf-progress-bar { display: block; height: 100%; border-radius: 999px; background: ${V.business}; transition: width 240ms ease; }
.tf-card[data-status='done'] .tf-progress-bar { background: ${V.success}; }
.tf-card-spinner { width: 10px; height: 10px; flex: none; border: 2px solid ${V.warn}; border-top-color: transparent; border-radius: 50%; animation: tf-spin 800ms linear infinite; }
@keyframes tf-spin { to { transform: rotate(360deg); } }

.tf-chip { font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 999px; background: ${V.bgLayer2}; color: ${V.label2}; white-space: nowrap; }
.tf-chip-warn { background: ${V.warnTertiary}; color: ${V.warnLabel}; font-weight: 600; }

/* —— 三态 —— */
.tf-empty { margin: auto; text-align: center; color: ${V.label2}; display: flex; flex-direction: column; gap: 12px; align-items: center; padding: 48px 24px; }
.tf-empty-art { font-size: 40px; opacity: 0.8; }
.tf-skeleton { border-radius: 8px; background: linear-gradient(90deg, ${V.bgHover} 25%, ${V.bgLayer2} 45%, ${V.bgHover} 65%); background-size: 200% 100%; animation: tf-shimmer 1.4s ease infinite; min-height: 84px; }
@keyframes tf-shimmer { to { background-position: -200% 0; } }

/* —— 横幅 —— */
.tf-banner { display: flex; align-items: center; gap: 8px; margin: 12px 20px 0; padding: 8px 12px; font-size: 13px; border-radius: 10px; border: 1px solid ${V.errorTertiary}; color: ${V.error}; background: ${V.errorTertiary}; }
.tf-banner .tf-btn { margin-left: auto; }
.tf-banner-warn { border-color: ${V.warnTertiary}; color: ${V.warnLabel}; background: ${V.warnTertiary}; }
.tf-sse-bar { flex-basis: 100%; font-size: 12px; color: ${V.warnLabel}; }

/* —— 抽屉 / 弹层 —— */
.tf-overlay { position: fixed; inset: 0; background: ${V.mask}; display: flex; justify-content: flex-end; z-index: 1300; animation: tf-fade 160ms ease-out; }
@keyframes tf-fade { from { opacity: 0; } }
.tf-drawer { width: min(480px, 94vw); height: 100%; background: ${V.bgBase}; border-left: 1px solid ${V.borderL2}; box-shadow: ${V.shadow3}; display: flex; flex-direction: column; animation: tf-slide 180ms ease-out; overflow: hidden; color: ${V.label}; }
@keyframes tf-slide { from { transform: translateX(24px); opacity: 0; } }
.tf-drawer-head { display: flex; align-items: center; gap: 10px; padding: 16px 20px 12px; }
.tf-drawer-title { font-size: 15px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-drawer-body { flex: 1; overflow-y: auto; padding: 18px 20px 24px; display: flex; flex-direction: column; gap: 20px; }

/* —— 标签页 —— */
.tf-tabs { display: flex; gap: 18px; padding: 0 20px; border-bottom: 1px solid ${V.borderL1}; flex: none; }
.tf-tab { padding: 6px 2px 9px; border-bottom: 2px solid transparent; margin-bottom: -1px; color: ${V.label2}; min-height: 24px; font-size: 13px; transition: color 120ms ease, border-color 120ms ease; }
.tf-tab:hover { color: ${V.label}; }
.tf-tab[aria-selected='true'] { color: ${V.label}; border-bottom-color: ${V.business}; font-weight: 600; }

.tf-section { display: flex; flex-direction: column; gap: 8px; }
.tf-section-title { font-size: 12px; font-weight: 600; color: ${V.label3}; letter-spacing: 0.02em; }
.tf-kv { display: grid; grid-template-columns: 72px 1fr; gap: 6px 12px; font-size: 13px; margin: 0; }
.tf-kv dt { color: ${V.label2}; }
.tf-kv dd { margin: 0; overflow-wrap: anywhere; }
.tf-list { display: flex; flex-direction: column; gap: 10px; }
.tf-item { border: 1px solid ${V.borderL1}; border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; background: ${V.bgBase}; }
.tf-item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tf-item-title { font-weight: 600; flex: 1; min-width: 0; font-size: 13px; }
.tf-evidence-label { font-size: 12.5px; line-height: 1.55; color: ${V.label2}; overflow-wrap: anywhere; }
.tf-evidence-diff { font-family: ${V.codeFont}; font-size: 11.5px; color: ${V.label3}; overflow-wrap: anywhere; }
.tf-evidence-checks { display: flex; flex-direction: column; gap: 6px; }
.tf-ac { display: flex; gap: 8px; font-size: 13px; align-items: baseline; }
.tf-ac-id { font-family: ${V.codeFont}; font-size: 11px; color: ${V.label3}; flex: none; }
.tf-hint { font-size: 12px; line-height: 1.5; color: ${V.label3}; overflow-wrap: anywhere; }

.tf-verdict { font-size: 11px; font-weight: 600; line-height: 18px; padding: 0 8px; border-radius: 999px; white-space: nowrap; }
.tf-verdict-pass { color: ${V.inkGreen}; background: ${V.successTertiary}; }
.tf-verdict-partial { color: ${V.warnLabel}; background: ${V.warnTertiary}; }
.tf-verdict-fail { color: ${V.errorSecondary}; background: ${V.errorTertiary}; }
.tf-verify { margin: 6px 0 0; background: ${V.bgLayer2}; border: none; border-radius: 8px; padding: 10px 12px; font-family: ${V.codeFont}; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; max-height: 140px; overflow-y: auto; color: ${V.label2}; }

/* —— 表单 —— */
.tf-form { display: flex; flex-direction: column; gap: 14px; }
.tf-field { display: flex; flex-direction: column; gap: 6px; }
.tf-field label { font-size: 12px; font-weight: 600; color: ${V.label2}; }
.tf-input, .tf-textarea, .tf-select { font: inherit; font-size: 13px; color: ${V.label}; background: ${V.bgBase}; border: 1px solid ${V.borderL3}; border-radius: 8px; outline: none; transition: border-color 120ms ease; }
.tf-input, .tf-textarea { padding: 8px 10px; }
.tf-select { height: 30px; padding: 0 8px; }
.tf-input:focus, .tf-textarea:focus, .tf-select:focus { border-color: ${V.business}; }
.tf-input::placeholder, .tf-textarea::placeholder { color: ${V.label3}; }
.tf-textarea { min-height: 84px; resize: vertical; }
.tf-actions { display: flex; gap: 10px; flex-wrap: wrap; padding-top: 4px; align-items: center; }

/* —— 时间线 —— */
.tf-timeline { display: flex; flex-direction: column; }
.tf-tl-entry { display: grid; grid-template-columns: 92px 1fr; gap: 10px; padding: 8px 0; border-top: 1px solid ${V.borderL1}; font-size: 13px; }
.tf-tl-entry:first-child { border-top: none; padding-top: 0; }
.tf-tl-time { font-size: 11px; color: ${V.label3}; font-variant-numeric: tabular-nums; padding-top: 2px; }
.tf-tl-label { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.tf-tl-actor { font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 999px; background: ${V.bgLayer2}; color: ${V.label2}; }
.tf-tl-detail { font-size: 12px; color: ${V.label2}; margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
.tf-tl-reject { border-left: 2px solid ${V.errorSecondary}; padding-left: 8px; }

/* —— 状态点（抽屉内 8px 加大版）—— */
.tf-status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.tf-dot-blue { background: ${V.business}; }
.tf-dot-green { background: ${V.inkGreen}; }
.tf-dot-amber { background: ${V.warn}; }
.tf-dot-red { background: ${V.errorSecondary}; }
.tf-dot-gray { background: ${V.label3}; }

.tf-session-link { font-family: ${V.codeFont}; font-size: 12px; font-weight: 500; color: ${V.business}; background: none; border: none; padding: 0; cursor: pointer; }
.tf-session-link:hover { text-decoration: underline; }
.tf-count-anim { animation: tf-pulse 360ms ease; }
@keyframes tf-pulse { 50% { transform: scale(1.08); } }

/* —— 侧栏顶部入口（sidebar 锚点注入；形态对齐宿主 nav-item）—— */
.tf-side-row { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border: none; border-radius: 8px; background: transparent; color: ${V.label2}; cursor: pointer; font-size: 13px; white-space: nowrap; font-family: inherit; transition: background-color 120ms ease, color 120ms ease; }
.tf-side-row:hover { background: ${V.bgHover}; color: ${V.label}; }
.tf-side-row:focus-visible { outline: 2px solid ${V.business}; outline-offset: 2px; }
.tf-side-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; flex: none; }
.tf-side-rail { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px; background: transparent; color: ${V.label2}; cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
.tf-side-rail:hover { background: ${V.bgHover}; color: ${V.label}; }
.tf-side-rail:focus-visible { outline: 2px solid ${V.business}; outline-offset: 2px; }
.tf-side-active { background: ${V.navActive}; color: ${V.label}; box-shadow: inset 3px 0 0 0 ${V.navAccent}; }

/* —— 看板层（shell.overlay 占用者）：只覆盖中栏，左边界由 JS 对齐侧栏 —— */
/* 看板层 = body 级 fixed 屏蔽层（不经 shell.overlay——那是一层 z-index:20
 * 的层叠上下文，槽位内渲染永远被 body 上的插件面板层（≥25）盖住）。
 * z-index 90 按实测分层约定取值：插件工作区层 ≤ 50（面板 25 / 内部 46 /
 * 其他插件弹层 50），宿主自有弹窗 ≥ 100（命令面板 100）——看板打开期间
 * 压过一切插件面板（屏蔽其他插件的影响），又不碰宿主自己的弹窗；关闭后
 * 整层移除、原样交还。左边界由 JS 按侧栏宽度设置（宿主左侧栏全程可见
 * 可点）；对插件零感知，无依赖无适配。 */
.tf-center-layer { position: fixed; top: 0; bottom: 0; right: 0; left: 248px; z-index: 90; display: flex; flex-direction: column; background: ${V.bgBase}; border-left: 1px solid ${V.borderL1}; pointer-events: auto; overflow: hidden; }
.tf-center-layer > .tf-root { flex: 1; min-height: 0; }

/* —— 浮动入口（侧栏锚点找不到时的保底；须高于看板层 90 才能点到）—— */
.tf-floating-entry { position: fixed; right: 16px; bottom: 16px; z-index: 1200; box-shadow: ${V.shadow2}; }

@media (prefers-reduced-motion: reduce) {
  .tf-root *, .tf-card, .tf-btn, .tf-progress-bar { animation: none !important; transition: none !important; }
}
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
