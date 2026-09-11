# 执行权限与审批通知 · 修复方案（PLAN-APPROVAL）

> 背景：真机首个任务「整理本机」卡死复盘（2026-09-10）。执行会话以默认 `read-only`
> 预设运行，子任务写文件触发沙箱提权 → 宿主发出 `approval/asked` → GUI 应答方只应答
> 「当前打开会话」，后台无头会话无人应答也无超时 → `whenIdle()` 永久挂起 → 任务无声停滞。
> 本方案治本，并交付两个用户能力：①创建时自选「完全权限 / 需要审批」；②全局通知栏 +
> 点击跳转处理审批。

---

## 1. 根因回顾（一句话版）

| # | 缺口 | 后果 |
|---|---|---|
| G1 | 后台会话的提权审批没有应答方（GUI 只答当前打开的会话） | 审批永远 pending |
| G2 | 适配器 `whenIdle()` 无看门狗 | 挂起无声，看板毫无异样 |
| G3 | `updateContract` 仅 draft/ready 可改 pins | 开工后合同权限无法修正 |
| G4 | 审批发生在会话流里，taskflow 数据层完全不可见 | 用户不知道有审批在等 |

## 2. 概念模型：两个正交轴

```
pins.permission   （会话预设：会话天生能做什么）
  read-only | workspace-write
executionMode     （提权策略：超出预设的动作怎么办）—— 新增
  'auto'     自动放行（完全权限）
  'approval' 转人工审批（需要审批）
```

创建表单的两个勾选项即这两种**组合档位**：

| 档位 | 映射 | 语义 |
|---|---|---|
| 🔓 完全权限（自动） | `permission=workspace-write` + `executionMode='auto'` | AI 在工作区内自由读写；残余提权也自动放行，全程不打扰 |
| 🔒 需要审批（推荐默认） | `permission=read-only` + `executionMode='approval'` | 只读基线；一切写入/提权转发给人在通知栏裁决 |

- API 层两轴独立可配（高级用法：workspace-write + approval = 出界才审批）。
- §7.1 确认门：仅 `executionMode='approval'` 且权限高于会话默认时才要求人工确认；
  `executionMode='auto'`（完全权限）免确认（`needsPermissionConfirm(pins)` 见引擎实现）。
- 兼容：旧任务无 `executionMode` → 按 `permission==='read-only' ? 'approval' : 'auto'` 推导；
  ledger 加载校验是宽松形状检查（`isLedger`），**新增可选字段无需升 schemaVersion**。

## 3. 数据模型（ledger 增量，全部可选字段）

```ts
// Contract.pins 新增
executionMode?: 'auto' | 'approval'

// Task 新增
approvals?: ApprovalRecord[]   // 审批记录（按任务截断保留最近 50 条，NFR-05 风格）

interface ApprovalRecord {
  id: string                  // ap_<随机>
  subtaskId: string
  sessionId: string
  toolName: string            // 如 "write"
  reason?: string             // 宿主提权理由（如 "escalate sandbox to workspace-write: …"）
  status: 'pending' | 'allowed' | 'elevated' | 'rejected' | 'expired'
  createdAt: number
  decidedAt?: number
  note?: string               // 人写的批语（可选）
}
```

事件留痕新增 note kind：`approval-requested / approval-allowed / approval-elevated /
approval-rejected / approval-expired`（view.ts 增加中文标签）。

## 4. Host / 引擎 / 适配器

### 4.1 审批桥（核心，治 G1）

`SessionAdapter` 新增可选钩子，引擎实现、适配器调用（依赖方向不变：adapter → engine 工具面）：

```ts
// 引擎提供：落库 pending（事件留痕 + SSE 推送）→ 返回等待人裁决的 Promise
onApprovalRequest?(input: { taskId; subtaskId; sessionId; toolName; reason? }):
  Promise<'allowed-once' | 'rejected'>
// 适配器实现：把会话预设原地提升（“本会话放行”用）
elevateSession?(sessionId: string, preset: string): Promise<void>
```

适配器在执行会话 `setup(agentCtx)` 里注册应答方（`dsh-acp` 同款官方形态）：

```ts
agentCtx.on('approval/request', async (req, next) => {
  if (mode === 'auto')        return 'allowed-once'            // 宿主自动记 asked/decided 审计对
  if (mode === 'approval')    return engine.onApprovalRequest(…) // 挂起等 decideApproval
  return next()
})
```

- `auto`：直接放行。宿主照常落 `approval/asked + decided` 审计对，留痕不丢。
- `approval`：Promise 挂起（不占轮次、无轮询），人在看板/通知栏裁决后 resolve。
- 会话取消（abort）→ 宿主侧自裁决 `cancelled`；引擎把该会话 pending 记录置 `expired`。

### 4.2 新 action：`decideApproval`

```ts
{ type: 'decideApproval', requestId, taskId, approvalId,
  decision: 'allow-once' | 'allow-session' | 'reject', note? }
```

- Guard：任务 in-progress、记录 pending；通过白名单 HTTP 端点（人 unmistakable）。
- `allow-once` → 记录 `allowed`，resolve 审批 Promise。
- `allow-session` → 记录 `elevated` + `adapter.elevateSession(sessionId,'workspace-write')`
  （后续工作区内操作不再产生审批；出界提权仍会再问——纵深防御）。
- `reject` → 记录 `rejected`；模型收到拒绝结果，可调整方案或调 `taskflow_report_blocker`。

### 4.3 看门狗（治 G2）

- 引擎配置 `sessionStallTimeoutMin`（默认 30）：执行会话在**无 pending 审批**前提下静默
  超时 → 子任务转 `blocked`（留痕 reason）+ `cancelSession` → 看板可见，可 `retryBlocked`。
- 有 pending 审批 = 等人，不算停滞：不自动裁决（避免误杀合法等待），审批卡显示等待时长。

### 4.4 其他

- `updateContract` 放宽：`blocked` 态也允许改 `pins`（re-arm §7.1 确认门）——治 G3。
- 执行提示词（§4.4 模板）按 executionMode 增加一段：auto →「你拥有工作区写权限，无需申请提权」；
  approval →「写操作会向用户发起审批，请合理批量操作；被拒后调整方案或报告阻碍」。
- 重启恢复：接管/取消会话时，其 pending 审批批量置 `expired`（留痕），通知自然消散。

## 5. 客户端

### 5.1 创建表单（能力①）

- 权限下拉替换为**执行模式单选**：🔒 需要审批（默认） / 🔓 完全权限。
- 选「完全权限」显示 ⚠️ 说明（AI 将无需逐步确认）；**auto 档创建即 `permissionConfirmed=true`，全程不打断**（§7.1 确认门只作用于 approval 档且权限高于会话默认的场景——2026-09-10 真机反馈修正：选「完全权限」还被要求授权属语义违背）。

### 5.2 抽屉审批区

- 子任务 tab：运行中子任务下内联审批卡（工具名 / 提权理由 / 等待时长），
  三按钮：`拒绝`（危险幽灵）· `仅此一次`（幽灵）· `本会话放行`（主按钮）+ 可选批语。
- 卡片与列头：`awaitingHuman: 'approval'` 琥珀 chip「待审批」；工具栏计数胶囊并入。

### 5.3 全局通知栏（能力②，治 G4）

宿主无 toast/notify 服务，且 `shell.overlay` 有 z-index:20 封顶（HANDOFF §3-10），
沿用项目已验证的 **body 级层**方案新增常驻 `NotificationLayer`：

- 容器 click-through、条目自管 pointer-events（shell.overlay 官方哲学）；`z-index: 95`
  （看板 90 之上 → 开着看板也可见；宿主自有弹窗 100 之下 → 不抢弹窗）。
- 数据源：既有 SSE 全量快照 diff——新出现的 `pending` 审批 → 通知条目
  「🔒 子任务「…」等待权限审批 · write → workspace-write」+「去处理」按钮；已裁决 → 移除。
- **点击跳转**：`setBoardFocus({ taskId, approvalId })`（模块级状态，与 `setBoardOpen`
  同套路）→ 打开看板 + 打开该任务抽屉并滚动/高亮审批卡。
- >3 条聚合折叠；`prefers-reduced-motion` 关闭动效；全部颜色走 `--dsw-alias-*`（NFR-01）。

## 6. 测试与验收

| 层 | 新增 |
|---|---|
| 协议 | `decideApproval` 校验（decision 枚举、approvalId 形状） |
| 引擎 | 审批桥 allow/reject/elevate 全链路；guard；看门狗转 blocked；恢复置 expired；updateContract@blocked |
| 客户端渲染 | 表单单选与映射；审批卡三按钮 dispatch；通知条目出现/消失；focus 跳转回调 |
| E2E | 主循环追加审批支线：approval 模式 → write 挂起 → allow-once → 完成；reject → 报告阻碍 → blocked |

三门禁照旧即 CI（改 client 后先 build 再 test）。目标 73 项 → ~95 项。

## 7. 落地顺序

1. **P1 host**：types/actions/engine（审批桥+decideApproval+看门狗+恢复）/adapter（应答方+elevateSession）
2. **P2 client**：表单 + 抽屉审批区 + NotificationLayer + focus 管线
3. **P3**：测试补齐 + demo mock 审批支线 + 本文档更新 + 真机验收清单
4. 部署：`npm run build` → 重启 `dsh --profile web`；旧卡死任务两条路任选：
   恢复路径接管（现在会走可见的审批/阻塞，不再无声），或直接取消重建。

## 8. 决策记录（用户已拍板，2026-09-10）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 创建表单默认档位 | **完全权限**（审批模式为可选项；默认档勾选🔓，保留 §7.1 开始确认一次点击） |
| D2 | 审批操作档位 | **两档：完全放行（本会话，后续不再问）/ 拒绝（仅拒这一次调用）**；「仅此一次放行」因会反复触发审批而砍掉 |
| D3 | auto 模式高危提权（>workspace-write） | **全部自动放行**（尊重「完全」语义，无人工闸门） |
| D4 | 看门狗默认 | **30 分钟**（可配置；等审批不算停滞，审批卡显示等待时长） |

## 9. 实施状态（2026-09-10 完成，待真机验收）

| 阶段 | 状态 | 落点 |
|---|---|---|
| 协议 | ✅ | types（ExecutionMode/ApprovalRecord/resolveExecutionMode）+ actions（decideApproval 白名单校验、pins.executionMode） |
| 引擎 | ✅ | 审批桥（toolApprovalRequest/actionDecideApproval/expireApprovals）、看门狗（sessionStallTimeoutMin 默认 30）、updateContract@blocked、恢复过期审批、dispose 清理 |
| 适配器 | ✅ | registerApprovalAnswerer（dsh-acp 同款 ctx.on("approval/request")）、elevateSession（liveSessions 跟踪）、adopt 同样注册应答方 |
| 客户端 | ✅ | 创建表单执行模式单选（默认完全权限/D1）、抽屉审批区（两档 D2）、NotificationBar（body 级 z 95）、focus.ts 跳转管线 |
| 测试 | ✅ | 73 → **86** 全绿（协议 23 / 引擎 21 / 视图 11 / 渲染 6 / E2E 2 / 其余不变）；E2E 含放行+拒绝双支线 |
| demo | ✅ | seed-2 = 审批模式演示（mock 先提权挂起，等通知栏/看板裁决）；demo-data/ledger.json 已重置，下次 `npm run demo` 重新播种 |

**真机验收清单**（build 后重启 `dsh --profile web`，刷新页面）：
1. 创建任务选「完全权限」→ 写操作无审批直接执行（§7.1 开始确认仍保留一次点击）。
2. 创建任务选「需要审批」→ 子任务写操作 → 右上通知栏出现条目 → 点「去处理」→ 看板打开并定位审批卡 → 「完全放行」后继续执行；另一任务走「拒绝」→ 模型报障转 blocked。
3. 旧卡死任务「整理本机」：重启后走恢复路径（恢复接管或转 blocked，均可见），或直接取消重建。
4. 看门狗：杀掉执行会话模拟静默 → 30 分钟后子任务转 blocked 可重试（生产值；测试里 3s 已验证）。
