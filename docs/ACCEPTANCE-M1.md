# dsh-taskflow M1 自验收报告

| | |
|---|---|
| 日期 | 2026-09-09 |
| 验收人 | AI（编码者自验，最终判定权仍在人） |
| 验收对象 | M1 MVP 核心闭环（REQUIREMENTS.md §8：FR-01～11） |
| 结论 | ✅ 沙箱内可验证范围全部通过；4 项依赖真实 dsh 宿主的验证点列为待真机复验（§4） |

---

## 1. M1 出口标准逐条核对

| 出口标准 | 结果 | 证据 |
|---|---|---|
| 主流程端到端可跑通：一个任务从一句话到 done（含一次打回迭代） | ✅ | `test/e2e/main-loop.test.ts`：一句话创建（无验收）→ AI 拆解补全验收 → 串行执行 → 证据 → 打回（批语注入）→ 第二轮 → 子任务批准 + 任务终批 → done → 归档；时间线断言覆盖 T1–T7/T10 与 S1–S5 全部转移 |
| typecheck 全绿 | ✅ | `npm run typecheck`（宿主面 tsconfig.json + 客户端面 tsconfig.client.json，strict） |
| test 全绿 | ✅ | `npm run test`：**71/71**（ledger 6 / 状态机 5 / 协议 16 / 引擎 15 / HTTP 8 / 视图模型 9 / 客户端渲染冒烟 5 / E2E 2） |
| build 全绿 | ✅ | `npm run build`：tsc 双面产物（dist/host、dist/protocol、dist/client）+ esbuild 客户端三形态（client.js / client.demo.js / client.dsh.js） |

## 2. FR 逐项验收

| FR | 需求 | 结果 | 实现与证据 |
|---|---|---|---|
| FR-01 | 任务创建（验收可选、pins 可选） | ✅ | `actionCreateTask`（engine.ts）；形状校验 actions.ts（标题 ≤120、workspace 绝对路径）；引擎测试「一句话创建」「requestId 幂等」 |
| FR-02 | AI 合同补全（缺失补稿；已给只细化） | ✅ | `handleDecomposeSuccess`：空 → `ai-drafted`；已给 → 等长逐条细化 + `originalHumanAcceptance` 对照 + `ai-refined`；不等长 → 拒绝并重试。测试：「用户已给验收：AI 只能等长细化并保留原文」「细化不等长 → 重试 → blocked」 |
| FR-03 | AI 任务拆解（结构化输出、schema 校验、失败重试 1 次） | ✅ | `validateDecomposeOutput`（协议层 5 个负向测试）；拆解失败自动重试 1 次 → T3′ blocked；拆解会话 id 留痕（拆解记录 tab） |
| FR-04 | 自动执行（autoStart 可关） | ✅ | autoStart 默认开（T4 自动）；关 → ready 等人工放行。测试「权限确认门」覆盖两条路径 |
| FR-05 | 执行引擎（每子任务一会话、注入合同、进度回写） | ✅ | `runSubtaskSession` + `renderExecutionPrompt`（§4.4 模板逐字实现）；`taskflow_update_progress` 便签入事件流；会话 id 记录 `sessionIds[]` |
| FR-06 | 完成证明三要素（Host 强制） | ✅ | `parseEvidenceInput` + `normalizeEvidence`（verification ≥1、selfCheck 与 acceptance 等长逐条、8KiB 截断）；缺项拒收并回结构化修正提示，不转状态。测试：协议 6 项 + 引擎「证据缺项被拒」 |
| FR-07 | 人工验收门（批准/打回批语必填） | ✅ | `approveSubtask`/`approveTask`/`rejectSubtask`（批语必填在 action 层校验）；审查页渲染证据报告卡（变更摘要/验证输出可展开/逐条对照并排）——jsdom 断言 |
| FR-08 | 迭代循环（批语注入、轮次计数、上限） | ✅ | 打回 → S5（review→rejected→in-progress）+ round+1 + 批语原文注入下一轮提示词；maxRounds 默认 3；达限 T7′ blocked → raiseMaxRounds + retryBlocked 恢复。测试：「打回：批语注入 round+1 轮次上限」全链路 |
| FR-09 | 状态历史（事件溯源、时间线） | ✅ | 一切状态变化必经 `transitionTask/transitionSubtask` 落事件（actor/from/to/reason/refs）；时间线 = 任务级+子任务级合并倒序（view.ts `mergedTimeline`）；E2E 断言完整转移序列与批语原文 |
| FR-10 | 看板视图（四列+受阻标红+搜索过滤） | ✅ | `boardGroups`（blocked 回原列标红：有子任务→实现中列，拆解受阻→待办列）；搜索覆盖标题/描述/子任务；待验收角标。视图模型 9 项测试 + DOM 断言 |
| FR-11 | 任务详情抽屉五区 | ✅ | 合同/子任务/验收/历史/拆解记录 五 tab（jsdom 断言）；`ai-refined` 对照视图 |

**M1 附带完成**：FR-12 依赖数据的落库与展示（deps 校验无环，`enforceDeps=false` M1 忽略调度守卫——Q2 裁决）；FR-15 归档/取消/搜索（cancel 二次确认 confirm:true 强制）。

## 3. NFR 逐项验收

| NFR | 结果 | 说明 |
|---|---|---|
| NFR-01 主题 | ✅* | 全部颜色走 `--dsw-alias-*`（唯一裸色值已清除，审计：`grep -v 'var(--'` 无命中）；fallback 仅供脱离宿主的 demo。*视觉外观未经人眼验收（沙箱无图形浏览器），以 DOM 断言 + 变量审计代替 |
| NFR-02 无障碍 | ✅ | 全控件 `:focus-visible`；列 `role=list`、卡 `role=listitem`、角标 `role=status`、抽屉 `role=dialog/tablist`；`prefers-reduced-motion` 关闭动效；点击区 ≥24px（按钮 min-height） |
| NFR-03 可靠性 | ✅ | Host 权威（浏览器只提交 action 等快照，乐观 UI 禁用）；ledger 临时文件+rename+fsync+0600（ledger.test 6 项：原子写/损坏隔离/写失败回滚/互斥）；重启恢复：无记录取消重排、有记录转接管（引擎测试 2 项） |
| NFR-04 一致性 | ✅ | 全量带 revision 快照 + SSE 增量（hello/change/心跳帧）；断线条提示 + 重连拉全量（UI） |
| NFR-05 性能 | ✅* | 事件有界（500/任务）、证据历史 20/子任务、验证输出 8KiB/条、action 64KiB；结构化 clone 快照。*「百级任务 <300ms」未压测（M1 无真实负载） |
| NFR-06 安全 | ✅ | action 白名单封闭（无命令/shell 字段，pins 键白名单）；权限确认门（read-only 基线 + re-arm + in-progress 补确认路径）；跨会话注入一律来源声明包装（测试「注入防护」）；同源信任围栏（Host loopback/trustedHosts + Origin + sec-fetch-site，8 项测试） |
| NFR-07 兼容 | ✅ | 纯插件（peerDependencies 声明 + cordis.patch.yml bundle manifest）；数据目录 `$DSH_HOME/taskflow/`；webServer/httpServer 新旧 API 兼容访问。*未在真实宿主装机运行 |
| NFR-08 可维护 | ✅ | TypeScript strict + noUncheckedIndexedAccess；分层 protocol/host/client 依赖单向（client 不 import host 运行时）；三门禁即 CI 门禁 |
| NFR-09 数据安全 | ✅ | 0600 落盘；损坏 → `ledger.json.corrupt-<ts>` 保留原始字节，空账本 + 显式横幅启动（UI banner + 测试） |

## 4. 待真实宿主复验项（诚实清单）

以下实现完整、类型检查通过，但**未在真实 dsh 宿主 + LLM 会话上运行过**（本沙箱无宿主进程与凭据）：

1. **dsh 适配器运行时**（`src/host/dsh/adapter.ts`）：`ctx.agents.create/followup/whenIdle`、`sessionPersistence.list`、结构化输出从 assistant 文本提取——类型对齐本机宿主源码（rc.7），行为需真机校准。
2. **权限预设应用时序**：经 `agent/created` 事件调用 `permissionPresets.set`（schedule 插件同款时序推导），需真机确认。
3. **dsh 客户端模块 bundle**（dist/client.dsh.js）：按 `window.__ModuleLoader__.load({id, factory(require)})` 约定构建（对齐宿主 packages/client/modules 源码），需真机确认装载；demo 形态（dist/client.demo.js）已验证。
4. **视觉验收**：UI 以 jsdom DOM 断言验证（5 项冒烟）；`npm run demo`（http://127.0.0.1:4173）可人工查看深浅色两版。

### 4.1 真机复验结果（2026-09-09，dsh 0.1.2-rc.1，taskflow-test profile）

在真实宿主（全局 `@deepseek-ai/dsh@0.1.2-rc.1` + 默认模型 glm-5.3-flash）上建立专用 profile（bundles: dsh-base + dsh-web-app，插件以 `link:` 接入）完成端到端复验：

| # | 复验项 | 结果 | 说明 |
|---|---|---|---|
| 1 | 主流程端到端（一句话 → 拆解 → 执行 → 举证 → 终批 done） | ✅ | 真实 LLM 拆解（AI 补全验收 + 逐子任务可检验验收标准）；执行会话真实运行 bash/fs 工具并产出三要素证据；人工批准 → done（T6） |
| 2 | 打回迭代（批语注入，FR-08） | ✅ | review 打回附批语 → 全任务回实现（T7，round 2）→ 第二轮证据落实批语要求（补 wc -l 验证）→ 终批 done |
| 3 | 权限确认门（§7.1） | ✅ | workspace-write 高于默认 read-only 时阻塞等确认；`startImplementation{confirmPermission}` 放行后会话以 workspace-write 挂载 |
| 4 | 报障路径（T8，不伪造证据） | ✅ | read-only 会话发现无文件工具时诚实调用 `taskflow_report_blocker` 而非伪造证据 |
| 5 | 客户端 bundle 宿主侧装载链 | ✅ | `dsh.client` 声明 → `exports["./client"]` 解析 → `__DSH_BOOT__` 模块图含 `dsh-taskflow/client.js` → combo 路由下发 `__ModuleLoader__` 包装产物。浏览器内 materialization（slots/视觉）仍需人机验收 |
| 6 | HTTP API + 信任围栏（NFR-06） | ✅ | loopback + Origin/sec-fetch-site 校验、action 幂等、state/SSE 全通 |

真机暴露并已修复的差异（rc.8 类型源 vs rc.1 运行时）：

1. **零运行时 @deepseek-ai 导入**（`compat.ts`）：link 安装形态下插件内的 @deepseek-ai 副本依赖树不完整；`SessionId`/`createUserMessage`/`defineTool`/`dshHomePath` 内联等价实现，类型增强经 `import type` 保留。
2. **事件形态**：rc.1 会话事件为 `{type, data}` 包装，assistant 文本在 `data.message.content`；事件快照经 `session.snapshotEvents()`。
3. **模型选择**：插件创建的会话必须传 `agentOptions: {provider, model}` 并在 setup 里安装 model-selection（提示词 `{{model}}` 变量来源），取自 `agentDefaultModel.currentSelection()`。
4. **预设挂载**：`setup` 中必须调用 `agentPresets.mount(agentCtx, presetId?)` 把会话挂到预设 standing mount——工具/提示词段/技能目录均来自预设组合，缺省用宿主默认预设；不挂载 = 空层会话（无 bash/fs 工具）。
5. **inject 声明**：cordis 代理禁止读取未声明 inject 的服务；补齐 `permissionPresets`/`agentPresets`/`agentDefaultModel`。
6. **retryBlocked 守卫**：拆解受阻（0 子任务）误用 retryBlocked 会进入死态；已加守卫并改由 `startDecompose` 恢复（附单测）。
7. **package.json**：`exports["./client"]` 指向 `__ModuleLoader__` 包装产物（宿主按此取浏览器 bundle）；移除不存在的 `dsh.client.inject` 声明。

## 5. 文档张力的实现裁决（进入 M1 前须裁决项已全部落定）

| # | 裁决 | 落点 |
|---|---|---|
| Q1 拆解会话预设 | M1 跟随宿主默认（presetId=null 不传） | adapter.createAgent |
| Q2 子任务并行度 | M1 全局串行（maxConcurrentSubtasks=1）；deps 数据落库+展示、调度守卫 M2 开启（enforceDeps 开关已实现） | EngineConfig |
| Q3 diff 展示 | M1 摘要（diffSummary 字符串）+ 会话 id 复制 | EvidenceCard |
| Q4 任务级一次性批准 | 进 M1（review 页主按钮「批准（全部通过 → done）」） | ReviewTab / approveTask |
| Q5 npm 包名 | 暂定 dsh-taskflow，发布前查重 | package.json |
| T5 守卫表述张力 | 裁决为「全部子任务 ∈ {review, done} 且 review 者证据齐全」；子任务级 S4 可在 in-progress 期间先行批准；approveTask 合并批准剩余（§4.6「合并为同一组点击」） | statemachine.ts 头注 + allSubtasksEvidencedOrDone |

## 6. 复验命令

```sh
npm install          # .npmrc 已带 legacy-peer-deps（dsh 包 npm peer 版本错位）
npm run typecheck    # 双面 strict 类型检查
npm run test         # 71 项（单测 + E2E + 客户端渲染冒烟）
npm run build        # dist/ 全产物
npm run demo         # http://127.0.0.1:4173 真实引擎 + mock 会话驱动完整 UI
```
