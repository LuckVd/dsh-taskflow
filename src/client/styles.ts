/**
 * 样式表（字符串模块：jsdom 冒烟与 dsh 宿主两种形态都可靠注入）。
 *
 * 视觉方案：design/ui-preview.html 方案三「分栏」（2026-09 评审选定）——
 * 淡灰列容器 + 白卡 + 卡片左侧状态色条 + 状态点语言；工具栏与按钮遵循
 * 预览稿「无灰描边盒」原则（仅信息蓝填充 / 幽灵两形态）。
 *
 * 设计语言对齐宿主主题（token 集 = dsh 0.1.2-rc.1 dsh-client-ui-theme 实际
 * 存在的变量，深浅色与皮肤自动适配）：bg-base/bg-layer-2 分层、border-l1/2/3、
 * state-*-primary/-secondary/-tertiary/-label 语义色、button-info-fill 主按钮、
 * shadow-lv1/2/3 阴影。fallback 仅为脱离宿主环境（如 jsdom 冒烟）兜底。
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
.tf-badge-approval { color: ${V.warnLabel}; background: ${V.warnTertiary}; }
.tf-badge-approval i { width: 6px; height: 6px; border-radius: 50%; background: ${V.warn}; flex: none; animation: tf-pulse 1.6s ease-in-out infinite; }
@keyframes tf-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

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

/* —— 任务详情弹窗（验收工作台容器）：居中大卡，窄屏退化为全屏 —— */
.tf-overlay-center { align-items: center; justify-content: center; padding: 24px; }
.tf-modal { width: min(1240px, 100%); height: min(820px, 100%); background: ${V.bgBase}; border: 1px solid ${V.borderL2}; border-radius: 14px; box-shadow: ${V.shadow3}; display: flex; flex-direction: column; overflow: hidden; color: ${V.label}; animation: tf-pop 180ms ease-out; outline: none; }
.tf-modal:focus-visible { outline: none; }
@keyframes tf-pop { from { transform: translateY(10px) scale(0.985); opacity: 0; } }
.tf-modal-head { display: flex; align-items: center; gap: 10px; padding: 14px 20px 10px; }
.tf-modal-title { font-size: 15px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-modal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 20px; display: flex; flex-direction: column; gap: 16px; scrollbar-width: thin; scrollbar-color: ${V.borderL3} transparent; }
/* 普通滚动态：子项不参与 flex 压缩（否则内容超高时区块会被压扁而非滚动） */
.tf-modal-body:not(.tf-modal-body-fill) > * { flex: none; }
.tf-modal-body-fill { overflow: hidden; }
.tf-modal-foot { flex: none; border-top: 1px solid ${V.borderL1}; padding: 10px 20px; }
.tf-modal-foot .tf-actions { padding-top: 0; }
.tf-modal .tf-banner { margin: 0; }

/* —— 验收工作台（2026-09-11 语义：任务级判定面优先 + 过程举证折叠附录 + 吸底裁决栏；
    2026-09-11 改版（方案B）：判定面 = 白卡蓝左条（重）vs 过程举证 = 无卡发丝线（轻），
    结论带 + 逐条语义色条，去重后验收标准只渲染一份）—— */
.tf-review { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.tf-review-scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; padding: 2px 4px 12px; scrollbar-width: thin; scrollbar-color: ${V.borderL3} transparent; }
.tf-review-scroll > * { flex: none; }
.tf-review-foot { flex: none; border-top: 1px solid ${V.borderL1}; padding-top: 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tf-review-foot .tf-textarea { flex: 1; min-width: 220px; min-height: 54px; }
.tf-review-foot .tf-btn { flex: none; }
.tf-task-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

/* —— 判定面容器（任务级）与结论带（方案B）—— */
.tf-judge { display: flex; flex-direction: column; gap: 12px; background: ${V.bgBase}; border: 1px solid ${V.borderL1}; border-left: 3px solid ${V.business}; border-radius: 12px; padding: 14px; box-shadow: ${V.shadow1}; }
.tf-banner2 { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-radius: 10px; background: ${V.warnTertiary}; border: 1px solid ${V.borderL1}; }
.tf-banner2.allpass { background: ${V.successTertiary}; }
.tf-banner2.allfail { background: ${V.errorTertiary}; }
.tf-banner-rate { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1; color: ${V.warnLabel}; white-space: nowrap; }
.tf-banner2.allpass .tf-banner-rate { color: ${V.inkGreen}; }
.tf-banner2.allfail .tf-banner-rate { color: ${V.errorSecondary}; }
.tf-banner-rate small { font-size: 12px; font-weight: 600; color: ${V.label3}; }
.tf-banner-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.tf-banner-title { font-size: 13px; font-weight: 700; }
.tf-banner-note { font-size: 12px; color: ${V.label2}; line-height: 1.5; overflow-wrap: anywhere; }
.tf-banner-bar { height: 4px; border-radius: 999px; background: ${V.bgLayer2}; overflow: hidden; }
.tf-banner-bar i { display: block; height: 100%; border-radius: 999px; background: ${V.warn}; transition: width 240ms ease; }
.tf-banner2.allpass .tf-banner-bar i { background: ${V.success}; }
.tf-banner2.allfail .tf-banner-bar i { background: ${V.error}; }

/* —— 执行过程举证（手风琴附录；方案B 降级为无卡发丝线行，与判定面白卡形成主次）—— */
.tf-proc { display: flex; flex-direction: column; gap: 0; }
.tf-proc-item { display: flex; flex-direction: column; }
.tf-proc-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 7px 4px; font-size: 12.5px; color: ${V.label2}; border-top: 1px solid ${V.borderL1}; transition: background-color 120ms ease; }
.tf-proc-item:first-of-type .tf-proc-row { border-top: none; }
.tf-proc-row:hover { background: ${V.bgHover}; color: ${V.label}; }
.tf-proc-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: ${V.label}; }
.tf-proc-item > .tf-ev, .tf-proc-item > .tf-item { border-top: 1px solid ${V.borderL1}; padding: 12px; margin: 0; }
.tf-proc-item > .tf-ev { border-top: 1px solid ${V.borderL1}; padding: 12px; border-radius: 0; }

/* —— 证据详情（分层：判定先行 / 自检前置 / 摘要限高 / 验证折叠）—— */
.tf-ev { display: flex; flex-direction: column; gap: 14px; }
.tf-ev-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tf-ev-title { font-size: 15px; font-weight: 700; flex: 1; min-width: 200px; }
.tf-checkbadge { flex: none; font-size: 12px; font-weight: 700; line-height: 20px; padding: 0 10px; border-radius: 999px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tf-checkbadge.ok { color: ${V.inkGreen}; background: ${V.successTertiary}; }
.tf-checkbadge.mid { color: ${V.warnLabel}; background: ${V.warnTertiary}; }
.tf-checkbadge.bad { color: ${V.errorSecondary}; background: ${V.errorTertiary}; }
.tf-checkbadge.mini { font-size: 10.5px; line-height: 16px; padding: 0 6px; font-weight: 600; }
.tf-ev-section { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid ${V.borderL1}; padding-top: 10px; }
.tf-ev-sechead { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; min-height: 24px; }
.tf-ev-caret { display: inline-block; flex: none; font-size: 9px; color: ${V.label3}; transition: transform 120ms ease; }
.tf-ev-caret.open { transform: rotate(90deg); }
.tf-ev-sechead .tf-section-title { font-size: 12.5px; }
.tf-ev-sechead .tf-link-btn { margin-left: auto; }
.tf-ev-summary { font-size: 13px; line-height: 1.6; color: ${V.label2}; overflow-wrap: anywhere; white-space: pre-wrap; }
.tf-ev-summary.tf-clamp { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.tf-ev-check { display: flex; align-items: flex-start; gap: 8px; border-left: 3px solid transparent; }
/* 方案B：逐条自检行的语义色条——pass 低调绿条 / partial 橙底 / fail 红底加粗，扫一眼定位未过项 */
.tf-ev-check-pass { border-left-color: ${V.success}; }
.tf-ev-check-partial { background: ${V.warnTertiary}; border-left-color: ${V.warn}; border-radius: 8px; }
.tf-ev-check-fail { background: ${V.errorTertiary}; border-left-color: ${V.errorSecondary}; border-radius: 8px; }
.tf-ev-check-fail .tf-ev-check-ac { font-weight: 600; }
.tf-ev-check .tf-verdict { margin-top: 2px; }
.tf-ev-check-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.tf-ev-check-ac { font-size: 13px; color: ${V.label}; overflow-wrap: anywhere; }
.tf-ev-check-note { font-size: 12px; line-height: 1.55; color: ${V.label3}; overflow-wrap: anywhere; }
.tf-ev-verify { display: flex; flex-direction: column; }
.tf-ev-verify-label { flex: 1; min-width: 0; font-family: ${V.codeFont}; font-size: 12px; color: ${V.label2}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-ev-verify .tf-verify { max-height: 260px; margin-top: 4px; }
.tf-ev > .tf-hint { padding-top: 2px; border-top: 1px solid ${V.borderL1}; }

/* —— 交付物（§4.5b）：产物本体区 + 只读预览 —— */
.tf-artifacts { border-left: 3px solid ${V.business}; padding-left: 10px; border-top: none; padding-top: 2px; }
.tf-artifact { display: flex; flex-direction: column; gap: 4px; border: 1px solid ${V.borderL1}; border-radius: 10px; background: ${V.bgBase}; padding: 10px 12px; }
.tf-artifact-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tf-artifact-icon { flex: none; font-size: 13px; }
.tf-artifact-path { flex: 1; min-width: 0; font-family: ${V.codeFont}; font-size: 12.5px; color: ${V.label}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-artifact-meta { display: flex; flex-direction: column; gap: 2px; }
.tf-artifact-desc { font-size: 12px; color: ${V.label2}; overflow-wrap: anywhere; }
.tf-artifact-verified { font-size: 11.5px; color: ${V.label3}; overflow-wrap: anywhere; }
.tf-artifact-preview { border-top: 1px solid ${V.borderL1}; margin-top: 6px; padding-top: 8px; }
.tf-artifact-previewbar { font-size: 11.5px; color: ${V.label3}; margin-bottom: 6px; }

/* —— 受限 Markdown 渲染（交付物预览正文）—— */
.tf-md { font-size: 13px; line-height: 1.65; color: ${V.label}; overflow-wrap: anywhere; }
.tf-md .tf-md-h { margin: 10px 0 6px; font-weight: 700; line-height: 1.35; }
.tf-md .tf-md-h:first-child { margin-top: 0; }
.tf-md .tf-md-h1 { font-size: 17px; border-bottom: 1px solid ${V.borderL1}; padding-bottom: 4px; }
.tf-md .tf-md-h2 { font-size: 15px; border-bottom: 1px solid ${V.borderL1}; padding-bottom: 3px; }
.tf-md .tf-md-h3 { font-size: 14px; }
.tf-md .tf-md-h4, .tf-md .tf-md-h5, .tf-md .tf-md-h6 { font-size: 13px; color: ${V.label2}; }
.tf-md .tf-md-p { margin: 6px 0; }
.tf-md .tf-md-list { margin: 6px 0; padding-left: 22px; display: flex; flex-direction: column; gap: 3px; }
.tf-md .tf-md-quote { margin: 6px 0; padding: 4px 12px; border-left: 3px solid ${V.borderL2}; color: ${V.label2}; }
.tf-md .tf-md-hr { border: none; border-top: 1px solid ${V.borderL1}; margin: 10px 0; }
.tf-md .tf-md-code { font-family: ${V.codeFont}; font-size: 12px; background: ${V.bgLayer2}; border-radius: 4px; padding: 1px 5px; }
.tf-md .tf-md-pre { background: ${V.bgLayer2}; border-radius: 8px; padding: 10px 12px; overflow-x: auto; max-height: 320px; font-size: 12px; line-height: 1.55; margin: 6px 0; }
.tf-md .tf-md-pre code { font-family: ${V.codeFont}; }
.tf-md .tf-md-link { color: ${V.business}; text-decoration: none; }
.tf-md .tf-md-link:hover { text-decoration: underline; }
.tf-md .tf-md-tablewrap { overflow-x: auto; margin: 6px 0; border: 1px solid ${V.borderL1}; border-radius: 8px; }
.tf-md .tf-md-table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.tf-md .tf-md-table th { background: ${V.bgLayer2}; font-weight: 600; text-align: left; }
.tf-md .tf-md-table th, .tf-md .tf-md-table td { padding: 6px 10px; border-bottom: 1px solid ${V.borderL1}; vertical-align: top; }
.tf-md .tf-md-table tr:last-child td { border-bottom: none; }

@media (max-width: 760px), (max-height: 560px) {
  .tf-overlay-center { padding: 0; }
  .tf-modal { width: 100%; height: 100%; border-radius: 0; border: none; }
}

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

/* —— 全局通知层（§7.1b）：body 级、z-index 95 = 看板 90 之上（开板也可见）、
   宿主自有弹窗 100 之下（不抢弹窗）。容器 click-through、条目自管 pointer-events。 —— */
.tf-notification-layer { position: fixed; top: 12px; right: 12px; z-index: 95; pointer-events: none; width: 340px; max-width: calc(100vw - 24px); }
.tf-notify-stack { display: flex; flex-direction: column; gap: 8px; }
.tf-notify { pointer-events: auto; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px; background: ${V.bgLayer2}; border: 1px solid ${V.borderL1}; box-shadow: ${V.shadow2}; }
.tf-notify-dot { width: 8px; height: 8px; border-radius: 50%; background: ${V.warn}; flex: none; }
.tf-notify-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.tf-notify-title { font-size: 12px; font-weight: 600; color: ${V.label}; }
.tf-notify-desc { font-size: 11px; color: ${V.label2}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-notify-go { flex: none; min-height: 26px; padding: 2px 10px; font-size: 12px; }

/* —— 执行模式选择卡（创建表单，§7.1b）—— */
.tf-mode-row { display: flex; gap: 8px; }
.tf-mode-card { position: relative; flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 10px; border-radius: 10px; border: 1px solid ${V.borderL1}; cursor: pointer; transition: border-color 120ms ease, box-shadow 120ms ease; }
.tf-mode-card:hover { background: ${V.bgHover}; }
.tf-mode-card.active { border-color: ${V.business}; box-shadow: 0 0 0 1px ${V.business} inset; }
.tf-mode-card input { margin: 0; accent-color: ${V.business}; }
.tf-mode-title { font-size: 12px; font-weight: 600; color: ${V.label}; display: flex; align-items: center; gap: 6px; }
.tf-mode-desc { font-size: 11px; line-height: 1.4; color: ${V.label2}; }

/* —— 抽屉审批区（§7.1b：两档裁决 = 完全放行 / 拒绝）—— */
.tf-approvals { display: flex; flex-direction: column; gap: 8px; border: 1px solid ${V.warnTertiary}; border-radius: 10px; padding: 10px; background: ${V.warnTertiary}; }
.tf-approval { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 10px; background: ${V.bgLayer2}; border: 1px solid ${V.borderL1}; }
.tf-approval-focus { outline: 2px solid var(--dsw-alias-focus-ring, #4c8dff); outline-offset: 2px; }
.tf-approval-reason { font-size: 11px; color: ${V.label2}; font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); word-break: break-all; }

/* —— 模型设置（工具栏齿轮浮层，§PLAN-MODEL）—— */
.tf-settings-anchor { position: relative; display: inline-flex; }
.tf-popover { position: absolute; top: calc(100% + 8px); right: 0; z-index: 30; width: 320px; max-width: min(340px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 12px; background: ${V.bgBase}; border: 1px solid ${V.borderL2}; box-shadow: ${V.shadow3}; animation: tf-fade 120ms ease-out; text-align: left; }
.tf-pop-head { display: flex; align-items: center; gap: 8px; }
.tf-pop-title { font-size: 13px; font-weight: 700; flex: 1; }
.tf-slot { display: flex; flex-direction: column; gap: 6px; }
.tf-slot-label { font-size: 12px; font-weight: 600; color: ${V.label2}; display: flex; align-items: baseline; gap: 6px; }
.tf-slot-desc { font-size: 11px; font-weight: 400; color: ${V.label3}; }
.tf-slot .tf-select { width: 100%; }
.tf-select-warn { border-color: ${V.warn}; }
.tf-pop-error { color: ${V.error}; }
.tf-pop-state { font-size: 11.5px; min-height: 16px; color: ${V.inkGreen}; }
.tf-chip-mono { font-family: ${V.codeFont}; font-size: 10.5px; }

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
