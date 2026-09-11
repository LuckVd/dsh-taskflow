# 全局模型设置 · 两槽模型选择（PLAN-MODEL）

> 需求（2026-09-10 用户提出）：在 taskflow 内单独设置模型，且**拆解 agent 与执行 agent
> 可分别配置**。评估结论：完全可行——模型选择在代码里本就只有一个收口点
> （adapter `createAgent`），宿主侧模型目录可直接结构性投影自 `ctx.llm`（项目已
> peer 依赖 `@deepseek-ai/dsh-llm`），零新增依赖。

## 1. 概念与语义

- taskflow **没有常驻主 agent**（调度器是宿主 JS 代码），「主/子 agent」映射为两槽：
  | 槽位 | 会话 | 典型用法 |
  |---|---|---|
  | `decompose` 拆解 | 拆解会话（规划/验收补全） | 配强模型 |
  | `execution` 执行 | 执行会话（子任务实现/举证，含 adopt 接管） | 配快/便宜模型 |
- 每槽 `null = 跟随宿主默认`（存量行为显式化，默认值，零迁移）；
  非 null = `{ provider, model, reasoningEffort? }`（同宿主 agentDefaultModel 形态）。
- 生效语义：**只影响之后新建的会话**；运行中会话不变。adopt/resume 同样接受
  agentOptions，宿主本就支持会话中途换模型（GUI /model 弹窗同款）。

## 2. 数据与 API

- 存储：`$DSH_HOME/taskflow/settings.json`（与 ledger.json 并列；刻意不进 ledger——
  设置不是任务状态，混入会污染事件留痕/快照 diff/健康检查语义；也不进插件 config——
  那需要重启宿主）。原子写（tmp + fsync + rename，0600）；损坏回退默认 + `lastLoadError`。
- 端点（同源信任围栏照旧）：
  - `GET  /api/taskflow/settings` → `ModelSettings`
  - `PUT  /api/taskflow/settings` → fail-closed 形状校验（未知字段/空串一律 400）
  - `GET  /api/taskflow/models` → `ModelCatalog`（`ctx.llm` 的 listProviders/listModels/
    resolveModelInfo 投影，单 provider 失败 fail-soft 跳过；未注入提供方 → 501）
- 引擎：`getModelSettings()/setModelSettings()`；两槽经 `DecomposeSessionInput.model` /
  `ExecutionSessionInput.model` 下传；adapter 取值 `input.model ?? defaultModelSelection()`。

## 3. UI（用户已确认方向）

- 入口：**看板工具栏右侧齿轮图标**（`tf-icon-btn`）→ 320px 浮层（不占创建表单，
  不值一个 480px 抽屉）。两槽各一个原生 `<select>`（`optgroup` 按 provider 分组），
  第一项「跟随宿主默认（provider/model）」。
- 推理力度：仅当选中模型暴露 efforts 时出现第三行（默认/low/medium/high…）。
- 即改即存（无确认弹窗）：成功闪「已保存 ✓」（2s）；失败回滚 UI 就地报错。
- 已保存模型从目录消失 → select 琥珀边 + 「⚠ 当前不可路由」chip，**不擅自清除**选择。
- Esc / 点击面板与齿轮以外区域关闭。

## 4. 留痕（「哪个模型干的活」）

- `EventRefs` 新增可选 `model`：标签 `provider/model[·effort]`（`modelLabel()`）。
- 引擎在 T2 开始拆解 / 拆解重试、S2 调度启动执行 / 重启执行会话四类事件上写 `refs.model`。
- 客户端：时间线行内 mono chip（`tf-chip-mono`）；证据卡「产出会话」行按
  sessionId 反查（`view.modelForSession`）追加同款 chip；未配置 = 不显示（= 宿主默认）。

## 5. 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 配置粒度 | 一期全局两槽；按任务覆盖（`pins.model`）留二期 |
| D2 | 入口位置 | 工具栏齿轮浮层；创建表单不放（高频表单保持轻） |
| D3 | 保存方式 | 即改即存，无确认弹窗（低风险可随时改回） |
| D4 | 目录数据 | host 自投影 `ctx.llm`（结构性访问），不引 `dsh-api-session-controller` 运行时依赖 |

## 6. 实施状态（2026-09-10 完成，待真机验收）

| 层 | 状态 | 落点 |
|---|---|---|
| 协议 | ✅ | types：SessionModelSelection / ModelSettings / ModelCatalog* / EventRefs.model |
| host | ✅ | settings.ts（store+校验+modelLabel）；engine（两槽下传+留痕+get/set）；http（GET/PUT settings、GET models）；plugin（settings.json 加载、ctx.llm 目录投影、路由注册、readBody 放行 PUT） |
| adapter | ✅ | createAgent / adoptSession：`input.model ?? defaultModelSelection()` |
| client | ✅ | ModelSettingsPopover（齿轮浮层全交互）；TaskflowApp 工具栏齿轮；api.ts 三方法；时间线/证据卡模型 chip；样式 `.tf-settings-anchor/.tf-popover/...`（全 token，NFR-01 审计通过） |
| demo | ✅ | serve.mjs 内存 settings + 静态双 provider 目录（deepseek / ollama） |
| 测试 | ✅ | 86 → **100** 全绿：settings 8（新增文件）/ http 6 / engine 2 / view 2 / render 1（浮层全交互冒烟） |

## 7. 真机验收清单（build 后重启 `dsh --profile web`，刷新页面）

1. 工具栏齿轮 → 浮层出现，两槽均显示「跟随宿主默认（<宿主当前默认>）」，
   下拉按 provider 分组且与宿主 GUI 模型选择器数据一致。
2. 执行槽选一个非默认模型 → 「已保存 ✓」；新建任务跑起来后，
   时间线 S2 行与证据卡出现模型 chip（= 所选模型）。
3. 关掉 dsh 宿主再开（重启）：齿轮浮层里的选择还在（settings.json 生效）；
   运行中会话重启接管路径正常。
4. 把执行槽设到一个不可路由的模型 → 新任务拆解或执行转 blocked，reason 可见；
   把该模型下架（或改回默认）后可恢复。
5. 推理力度行：选 deepseek-reasoner 类暴露 efforts 的模型才出现；改力度后
   留痕标签带 `·effort` 后缀。
