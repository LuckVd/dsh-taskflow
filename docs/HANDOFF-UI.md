# dsh-taskflow UI 改版 · 交接记录（2026-09-10）

> 给下一个会话的上 handoff。背景：方案三「分栏」已落地真实客户端并在真机可用，
> 用户确认主链路 OK（侧栏保留、看板换出）。用户报的 3 个问题（§4）已全部修复，
> **待真机复验后提交**。本文档是唯一事实源：代码状态、踩坑结论、待办都在这里。

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| 分支 / 基线 | `main`，UI 改版功能提交 `8e074c6`（**未推送**，ahead 3：M1 + 皮肤集成 + 本文档笔） |
| 工作区 | **干净**（UI 改版全部已提交：功能在 `8e074c6`，文档+设计稿在其后的 docs 笔） |
| 门禁 | typecheck / build / test 全绿（**73/73**，渲染冒烟吃 `dist/client.demo.js`，**改 client 后必须先 build 再 test**） |
| 真机宿主 | `dsh --profile web`（`link:/opt/pro/dsh-taskflow` 软链安装，node_modules 符号链接直指本项目）；GUI 有认证网关，curl 不可用，靠用户人肉验收 |
| HMR | `dsh-client-hmr` 无条件挂载，500ms 轮询所有插件 bundle，`rebuilt()` 重读进图 → **`npm run build` 后刷新页面即生效** |
| 另一 profile | `taskflow-test`（同款 link: 安装，真机验收专用，未动） |
| demo | `npm run demo` → http://127.0.0.1:4173（真实引擎 + mock 会话，与宿主无关，可随时重启） |

### 用户需求（已确认口径）

1. 侧栏入口位置：**DeepSeek Harness logo 之下、「新会话」之上**（不是 footer）。
2. 点击 = **只换出右侧中栏内容**，左侧栏原位保留可点，**不要二级页面/全屏浮层**。
3. 不遮挡侧栏任何控件（含折叠态的「展开侧边栏」、底部设置行）。
4. 看板视觉 = `design/ui-preview.html` **方案三「分栏」**（含详情抽屉形态）。
5. 点其他会话 → **自动退出看板**，不得拦截会话切换。
6. **通用性红线（用户明确要求）**：不与其他插件产生任何依赖、不做单独适配。
   看板层 = body 级屏蔽层，只认宿主分层约定（§2.3）；会话退出只认宿主核心
   sessions 服务（§2.4）。

## 2. 已实现（本轮完成）

### 2.1 方案三皮肤（styles.ts 全量重写）

- 列：`bg-layer-2` 圆角容器 + `border-l1`；计数胶囊挂在列头，**待验收列 >0 时琥珀 hot 态**
- 卡片：白底无描边 + `::before` 左侧状态色条（`data-status` 驱动）+ 微阴影；meta 行 = 状态点 · n/m 子任务 · 轮次胶囊 · 旋转 · 右对齐相对时间
- 工具栏：填充式搜索框（放大镜 SVG）+ 幽灵过滤下拉 + 琥珀待验收胶囊（`margin-left:auto`）+ 蓝主按钮；按钮只有「信息蓝填充/幽灵/危险幽灵」三形态（无灰描边盒）
- 抽屉：480px；头部 = 状态点+标题+轮次胶囊+图标关闭；证据报告卡扁平结构（变更摘要行 / mono diff 行 / 通过胶囊+`pre.tf-verify` / 逐条自检 `ac_N pass` 行）；时间线上边线+批语左红线；verdict 软底胶囊
- 所有颜色仍在 `var(--token, fallback)` 内（审计脚本见 §5）；`--ink-green`/`--on-info`/`--dsw-specific-nav-*` 带兜底链

### 2.2 宿主集成（index.ts，真机已跑通 ✅）

```
apply
├── installSidebarEntry()          —— DOM 锚点注入（无 React、无 cordis）
│   · 找「新会话」按钮（textContent 或 aria-label/title 匹配 新会话/New Session）
│   · container 插到它前面 = logo 下、新会话上
│   · MutationObserver 守护重锚定；折叠态按锚点是否带文本切 tf-side-row/rail
│   · 30 次×500ms 找不到 → installFloatingEntry（右下角浮动入口兜底）
│   · 锚定时顺带捕获 sidebarColumn（见 2.3）
└── ctx.effect(mount)
    └── slots.inject('shell.overlay', () => slots.register(…BoardOverlayLayer))
        —— 必须 inject 延迟注册！直接 register 会被拒（见 §3）
```

- `BoardOverlayLayer`：常驻组件；`boardOpen=false` 渲染 `null`；`=true` 渲染 `.tf-center-layer`
  （`position:fixed; top/bottom/right:0`，**`left` 由 JS 设为侧栏列宽度**，`ResizeObserver`
  盯 `sidebarColumn` 跟随折叠动画）→ 侧栏全程可见可点，better-sidebar 之外的中栏区域被看板占据
- 开合状态是**模块级变量 + listener 集合**（`setBoardOpen`），点击回调里**零 cordis 调用**
- 入口/看板层联动：入口变高亮 `tf-side-active` + 文案切「返回会话」；看板工具栏右侧也有「✕ 返回会话」（`TaskflowApp` 的可选 `onClose` prop，demo/测试不传不渲染）
- 降级链（都会发生但不该走到）：overlay 注册失败 → `tf-fallback-layer` 全屏层（右下角关闭钮）；inject 也不可用 → 同上
- 顺手修的暗病：**`tf-root` 此前从未挂到根节点**（reset 全是死代码）；挂上后又暴露特异性 bug——`.tf-root button` 会压过 `.tf-card` 的 padding，已改 `.tf-root :where(button)`（零特异性）。用户真机确认溢出已修（P2 关闭）。

### 2.3 看板层 = body 级屏蔽层（现行方案，P1 最终解）

- **为什么槽位内必败**：`shell.overlay` 宿主容器 `.overlayLayer` 是 `position:absolute; z-index:20`
  的层叠上下文（dsh-client-ui-layout 实测），注册进去的组件 z-index 被封顶在 20；而第三方
  插件的面板层直接挂 body（better-sidebar `[data-dsh-panel-host]` = fixed z-index:25）——
  槽位内渲染怎么做都会被盖住。中间一版「纯几何追踪宿主中栏让位」也因层叠上下文外的面板
  依旧浮在看板之上而不达意，已删除。
- **现行**：看板层不注册槽位，直接 `document.body` 挂 `div.tf-center-layer`（与旧降级层同套路），
  `z-index: 90` —— 实测分层约定：插件工作区层 ≤ 50（better-sidebar 面板 25 / 内部 46、
  skill-hub 弹层 50），宿主自有弹窗 ≥ 100（命令面板 100）。即**看板打开期间屏蔽其他插件的
  影响**（盖住不可交互），关闭整层移除、原样交还；对插件零感知。
- 几何：`top/bottom/right: 0`，`left` = 侧栏宽度（ResizeObserver 跟随折叠/窄态动画，侧栏
  重锚定立刻同步）；宿主左侧栏全程可见可点。
- 关闭按钮走 `TaskflowApp` 工具栏内建 `onClose`（`mountTaskflow` 新增可选 `options.onClose`），
  独立的降级关闭钮已随 `.tf-fallback-*` 删除。
- `clientInject = ['sessions']`（slots 已不再使用）。

### 2.4 会话切换自动退出（本轮，P3）

- `clientInject = ['slots', 'sessions']`；`watchSessionSwitch` 订阅宿主核心 `sessions.list` feed（runner 文档 face，与具体插件无关）：`current` 变化（切会话/关会话）→ `setBoardOpen(false)`，被动退出视图，不拦截切换；回调里零 cordis 调用。
- feed 不可用时静默跳过（可选链 + try/catch，不挂不崩）；订阅经 `ctx.effect` 挂 fiber，卸载自动退订。
- 注意：`sessions` 是宿主核心服务（会话列表 UI 的数据源），不是第三方插件——受 §1 用户需求 6 约束的审查通过。

## 3. 宿主槽位系统·关键结论（花了两轮真机踩出来的，别再踩）

1. **侧栏没有「logo 下」的槽位**。`dsh-client-ui-sidebar` 的 SlotMap 只有：
   `sidebar.brand.mark / brand.name / workspaces / settings / footer.action`。
   brand 行和新会话按钮是 shell 自有控件 → 只能 DOM 锚点注入（现状）。
2. **运行时（click 回调里）调 `slots.register` 会被拒** —— cordis 服务代理要把 ctx 绑回
   调用方 fiber，DOM 事件回调里调用方上下文丢失。symptom：注册抛错 → 我方静默降级全屏。
   （`conversation` 单槽动态换出方案因此废弃。）
3. **apply 时直接 `slots.register` 也被拒**（槽位树未就绪）。**唯一可行形态**：
   `ctx.effect(() => slots.inject(seat, factory))` —— inject 延迟到槽位树就绪后再落地注册。
   这是宿主 runner 文档的标准第三方形态，v1 就是这么写的（当时能挂上 footer 入口+浮层）。
4. **`shell.overlay`**（dsh-client-ui-layout 声明）：list 槽、加法式、frame-wide、层本身
   click-through、条目自管 pointer-events。常驻挂载+自管显隐是官方认可姿势。
5. `conversation` 槽位 = 中栏整体（single，注册即换出+注销恢复，文档明确支持）——
   **apply 时若用 inject 语义或许也能做**，但 click 时切换已证死路；若未来想「真·换出中栏」，
   可试：apply 时以 inject 挂进 `conversation` 的壳组件内部再按状态二选一渲染（聊天透传 or 看板）。
   未验证，别轻易回这条老路。
6. `dsh-better-sidebar` 是**右侧** VSCode 式面板（explorer/editor/terminal/git），
   对外暴露 service（`./client/service`）供注册 tabs/viewer —— 与左侧栏无关。
7. client bundle（`dist/client.dsh.js`）里 react/react-dom 是 **external**，
   `factory(require)` 注入宿主同款 React 实例 → 注册组件用自家 `createElement` 完全安全。
8. 宿主 GUI 在 28080（`--profile web`），28081 是认证网关口；`~/.dsh/web-host.log` 几乎不打日志。
9. **z-index 分层实测约定（选层用）**：宿主壳层 ≤ 100（layout overlay 20 / 命令面板 100），
   插件工作区层 body 级 25+（better-sidebar 面板 25、内部 46，skill-hub 50）。
   要压插件 → 25~99 区间；要被宿主弹窗盖住 → < 100。看板层取 90。
10. **shell.overlay 是 z-index:20 的层叠上下文**：槽位内组件的 z-index 出不了 20，
    永远压不过 body 级插件层——需要「盖住插件」的 UI 必须挂 body（§2.3）。
    本项目因此已不再注册 shell.overlay。

## 4. 原报 3 问题 · 修复记录（待真机复验）

### P1 · 和侧边栏插件（dsh-better-sidebar）遮挡 → 已改「屏蔽」方案（待真机复验）

- 用户确认遮挡对象：看板工具栏右侧「✕ 返回会话」被 better-sidebar 右侧展开面板盖住。
- 迭代史：(a) 消费 better-sidebar 的 `--dsh-sidebar-width/height` 变量——**被用户否决**
  （红线：不与插件产生依赖），回退；(b) 纯几何追踪宿主中栏让位——技术上通用，但
  shell.overlay 的 z-index:20 层叠上下文决定了槽位内怎么做都压不过 body 上的插件面板，
  真机复验不通过，已删除。
- 最终方案（用户拍板方向）：**看板打开 = 屏蔽其他插件的影响**。body 级层 + z-index 90，
  盖住一切插件工作区面板，关闭后原样交还（§2.3、§3-9/10）。
- 真机复验点：打开 better-sidebar 右面板再开看板 → 看板应盖住面板，「返回会话」完整可见
  可点；面板开合/拖宽时看板不闪不跳；关闭看板后面板恢复可交互；宿主左侧栏全程可点；
  宿主命令面板（z 100）等自有弹窗仍应盖在看板之上。

### P2 · 卡片文字超出边界 → 已修（用户真机确认）

- 根因：`.tf-root button (0,1,1)` 压过 `.tf-card (0,1,0)` 的 padding → 已改 `.tf-root :where(button)`。
- 用户已刷新真机确认不再溢出，关闭。

### P3 · 点击其他会话应自动退出看板 → 已修（宿主核心订阅）

- 方向 a 命中：宿主 `sessions.list` feed（`getSnapshot().current` + `subscribe`），
  runner 文档内的标准 face，better-sidebar 同款消费方式佐证可行。
- 实现 §2.4；未走 DOM 观察保底（宿主 face 已足够，避免多一套会话行结构的脆弱探测）。
- 真机复验点：看板开着点侧栏其他会话 → 看板应自动收起、会话正常切换无拦截；
  会话关闭（列表里没了）同样收起。

## 5. 复验命令 / 工具

```sh
npm run typecheck   # 双面 strict
npm run build       # 先 build！渲染冒烟测试吃 dist/client.demo.js
npm run test        # 73 项
npm run demo        # http://127.0.0.1:4173 人工核对（非宿主环境）
```

- 裸色值审计（NFR-01）：提取 `TASKFLOW_CSS`，剥掉 `var(...)` 后不得残留 `#hex`/`rgb(a)`（历史命令在本会话，可重写）
- 真机 profile：`~/.dsh/profiles/web/`（bundles 含 dsh-taskflow，link: 安装）
- 宿主槽位契约阅读路径：`/root/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
  下 `dsh-client-ui-{sidebar,layout,conversation}/lib/types/client/contract/*.d.ts`、
  `dsh-cordis-client-runner/lib/client.js`（register 代理守卫 + SlotCore 文档）
- design/：`ui-preview.html`（右下角控制条切三案+深浅色）+ `previews/*.png`（8 图）

## 6. 新会话上手清单

1. 读本文档 §1–§4（P1/P2/P3 已修，待真机复验）。
2. `git log --oneline -3` 确认基线（功能提交 `8e074c6`；含本文档的 docs 笔在其上，均未推送——推送前先跟用户确认）。
3. 请用户真机复验 §4 三个「复验点」。
4. 全过后一次性提交（建议拆两笔：皮肤+集成 / 文档+测试），再推 origin。
5. 若 P1 复验仍异常：按 §2.3 查层——看板层是 body 级 `.tf-center-layer`（z-index 90），
   DevTools 里直接看它是否在 DOM、left 是否对齐侧栏宽度、被什么盖住（对比插件面板层的
   z-index，速查表在 §3-9）。
