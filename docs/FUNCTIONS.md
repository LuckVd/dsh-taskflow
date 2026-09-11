# dsh-taskflow 功能文档（功能规格说明书）

| | |
|---|---|
| 项目 | dsh-taskflow · AI 合同式任务看板 |
| 版本 | v0.1（规划稿） |
| 日期 | 2026-09-09 |
| 状态 | 📋 评审中 —— 未开始编码 |
| 上游文档 | [`REQUIREMENTS.md`](REQUIREMENTS.md)（需求、FR/NFR 编号来源） |

> 本文档回答「每个功能具体怎么做」：数据长什么样、状态怎么流转、每个 FR 的行为规格、界面怎么摆、接口长什么样。编码阶段以本文档为唯一行为基准；与 PRD 冲突时以 PRD 的范围与优先级为准。

---

## 1. 概念模型

```
Board（看板视图）
  └── Task（任务 = 一份合同）
        ├── Contract 合同体
        │     ├── objective        目标（一句话）
        │     ├── acceptance[]     验收标准（可空 → AI 补全）
        │     └── pins             上下文钉脚 { workspace, preset, permission }
        ├── Subtask[]（子任务，拆解产出，可递归一层）
        │     ├── 同样是合同体（目标 + 建议验收）
        │     ├── deps[]           依赖（M2）
        │     ├── evidence         完成证明
        │     └── verdict          验收结论
        ├── events[]               状态事件历史（不可变，追加写）
        └── meta                   轮次、创建者、时间戳等
```

三条不变量（Invariants，任何实现必须保证）：

1. **Host 权威**：任务的唯一事实源在 Host 端 ledger；浏览器操作是「提交 action → 等确认快照」，不是直接改本地状态。
2. **事件只追加**：状态只能通过产生新 Event 改变；Event 不可修改删除。
3. **无证据不进验收**：`running → review` 的转移在 Host 侧校验 Evidence 三要素齐全，缺失即拒绝转移。

---

## 2. 数据模型（ledger schema v1）

存储：`$DSH_HOME/taskflow/ledger.json`，临时文件 + 原子 rename 写入，模式版本 `schemaVersion: 1`。

```ts
// —— 顶层文档 ——
interface Ledger {
  schemaVersion: 1;
  revision: number;               // 单调递增；每次变更 +1，SSE 推送
  tasks: Task[];
}

// —— 任务 ——
interface Task {
  id: string;                     // tf_<随机>，创建时生成
  title: string;                  // ≤ 120 字
  description: string;            // 自由文本，用户的原始诉求
  contract: Contract;
  status: TaskStatus;
  subtasks: Subtask[];
  events: TaskEvent[];            // 追加写
  round: number;                  // 当前迭代轮次，从 1 开始
  maxRounds: number | null;       // 迭代上限，null = 不限
  createdAt: number;              // epoch ms，下同
  updatedAt: number;
  createdBy: "human";
}

interface Contract {
  objective: string;
  acceptance: AcceptanceItem[];   // 允许为空 → 触发 AI 补全
  sourceOfAcceptance: "human" | "ai-drafted" | "ai-refined";
  //   human: 用户手写；ai-drafted: 用户没给，AI 全稿；
  //   ai-refined: 用户给了，AI 在其上细化（原文保留在 originalHumanAcceptance）
  originalHumanAcceptance?: AcceptanceItem[];  // ai-refined 时保留用户原文，UI 可对比
  pins: {
    workspace: string;            // 绝对路径
    presetId: string | null;      // Agent 预设，null = 宿主默认
    permission: string;           // 权限 id，如 "read-only" | "workspace-write"
  };
}

interface AcceptanceItem {
  id: string;                     // ac_<随机>
  text: string;                   // 可检验的描述
}

// —— 子任务 ——
interface Subtask {
  id: string;                     // <taskId>_s<n>
  title: string;
  detail: string;                 // 实现说明（拆解会话产出）
  acceptance: AcceptanceItem[];   // 拆解时强制产出，不允许为空
  deps: string[];                 // 依赖的其他 subtask id（M2 启用强制校验，M1 仅展示）
  status: SubtaskStatus;
  round: number;                  // 子任务自身迭代轮次
  evidence?: Evidence;            // 最近一轮提交的证据
  history: SubtaskEvent[];        // 子任务级事件
  sessionId?: string;             // 当前/最近一轮执行的 DSH 会话 id
  sessionIds: string[];           // 历轮全部会话
  attempt: number;                // 会话启动次数
}

// —— 完成证明 ——
interface Evidence {
  submittedAt: number;
  changesSummary: string;         // 变更摘要（agent 产出）
  verification: {                 // 验证输出（≥1 条）
    label: string;                // 如 "pnpm test"
    output: string;               // 命令输出摘录（截断至 8KiB）
    passed: boolean;
  }[];
  selfCheck: {                    // 逐条对照验收标准（与 acceptance 等长）
    acceptanceId: string;
    verdict: "pass" | "partial" | "fail";
    note: string;
  }[];
  refs: {
    sessionId: string;            // 产出会话
    diffSummary?: string;         // diff 统计（+n −m，涉及文件列表）
  };
}

// —— 事件（任务级与子任务级同构）——
interface TaskEvent {
  id: string;
  at: number;
  from: TaskStatus | null;        // null = 创建事件
  to: TaskStatus;
  actor: "human" | "ai" | "system";
  reason?: string;                // 打回批语 / 自动转移原因等
  refs?: { subtaskId?: string; sessionId?: string };
}
```

**状态枚举**

```ts
type TaskStatus =
  | "draft"        // 草稿：已创建，尚未触发拆解
  | "decomposing"  // 拆解中：AI 拆解会话运行中
  | "ready"        // 就绪：拆解完成（或无子任务直接待执行），待运行
  | "in-progress"  // 实现中：存在运行中/待验收循环的子任务（用户语汇「完成中」）
  | "review"       // 待验收：全部子任务证据齐全，等人工判定
  | "done"         // 已完成：人工批准
  | "blocked"      // 受阻：执行失败/达到迭代上限/依赖死锁等
  | "cancelled"    // 已取消
  | "archived";    // 已归档（只读）

type SubtaskStatus =
  | "pending"      // 未开始（等依赖或等调度）
  | "in-progress"  // 会话运行中
  | "review"       // 证据已提交，待人工判定
  | "done"         // 已批准
  | "rejected";    // 被打回（短暂状态，注入批语后立即转回 in-progress）
  | "blocked";     // 失败且达到迭代上限 / 依赖无法满足
```

> 命名说明：用户语汇的「完成中」对应 `in-progress`；「待验收」对应 `review`。UI 文案用「实现中」「待验收」。

---

## 3. 状态机

### 3.1 任务级转移表

| # | 从 → 到 | 触发者 | 触发条件 / 守卫 | 副作用 |
|---|---|---|---|---|
| T1 | null → draft | human | 创建 action 合法 | 写创建事件 |
| T2 | draft → decomposing | human（点「开始拆解」）或 system（创建时勾选自动） | description 非空 | 启动拆解会话 |
| T3 | decomposing → ready | system | 拆解会话产出合法子任务集（schema 校验通过） | 落库子任务；若 `autoStart` 则立即触发 T4 |
| T3′ | decomposing → blocked | system | 拆解会话失败 / 产出不合 schema / 重试耗尽 | 写失败原因事件 |
| T4 | ready → in-progress | system | `autoStart` 开（默认）或 human 点「开始实现」 | 调度器按依赖与 WIP 启动子任务会话 |
| T5 | in-progress → review | system | **全部子任务** status ∈ {done} 且各自 evidence 齐全 | 生成验收待办，触发通知 |
| T6 | review → done | **human** | 点「批准」（可批量） | 任务终态；写批准事件 |
| T7 | review → in-progress | **human** | 点「打回」且批语非空；未达 maxRounds | 选中的未通过子任务转 rejected→in-progress，批语注入下轮；round+1 |
| T7′ | review → blocked | system | 打回时已达 `maxRounds` | 写「迭代上限」事件，等人工处理（可提高上限继续） |
| T8 | in-progress → blocked | system | 子任务会话失败且重试耗尽 / 达迭代上限 | 写原因；解除阻塞需人工 |
| T9 | 任意（非终态）→ cancelled | human | 二次确认 | 终止运行中会话（尽力而为） |
| T10 | done/cancelled → archived | human | — | 只读，从看板主视图隐藏 |

### 3.2 子任务级转移表

| # | 从 → 到 | 触发者 | 守卫 | 说明 |
|---|---|---|---|---|
| S1 | null → pending | system | 拆解产出落库 | — |
| S2 | pending → in-progress | system（调度器） | deps 全 done（M1 恒真）且 WIP 未满且任务 in-progress | 启动执行会话：注入合同 + 上轮批语 |
| S3 | in-progress → review | **agent（会话内工具）** | Evidence 三要素齐全（Host 校验），否则工具调用被拒并回给 agent 修正提示 | 会话结束前提交；会话意外终止则转 blocked 候选 |
| S4 | review → done | **human** | 验收页批准 | 单子任务即可批；任务级 T5 等全部 done |
| S5 | review → rejected → in-progress | **human** | 打回批语非空 | rejected 为瞬时状态：落批语事件后立刻转 in-progress 重新排队 |
| S6 | in-progress/blocked → blocked | system | 会话失败重试耗尽 / 达子任务迭代上限 | 等人工「重试」「提高上限」或「跳过验收强制 done」 |

### 3.3 状态机图（文字版）

```
                    ┌──────────┐
        创建 ──────▶ │  draft   │
                    └────┬─────┘
                     开始拆解（T2）
                    ┌──────────┐   拆解失败 T3′
                    │decompos- │──────────────▶ blocked
                    │  ing     │
                    └────┬─────┘
                     拆解成功（T3）
                    ┌──────────┐
                    │  ready   │◀──────── 打回后重排（S5 语义）
                    └────┬─────┘
                       开始实现（T4）
   ┌───────────────────────────────────────────┐
   │                ┌──────────┐                │
   │   子任务循环     │in-progress│◀── 打回 ───┐  │
   │                └────┬─────┘            │  │
   │              全部证据齐全（T5）          │  │
   │                 ┌──────────┐         │  │
   │                 │  review  │─────────┘  │
   │                 └────┬─────┘   不通过(T7) │
   │                  批准(T6)                  │
   │                 ┌──────────┐               │
   └────────────────▶│   done   │               │
                     └──────────┘               │
   任意非终态 ──T9──▶ cancelled ──T10──▶ archived（终态只读）
```

---

## 4. 功能规格（逐项对应 FR）

### 4.1 任务创建（FR-01）

**入口**：看板左上「新建任务」按钮 → 右侧滑出创建抽屉。

**表单字段**：

| 字段 | 必填 | 说明 |
|---|---|---|
| 标题 | 是 | ≤120 字，占位提示「一句话说清要做什么」 |
| 描述 | 是 | 自由文本；这是 AI 的主要输入 |
| 验收标准 | 否 | 逐条输入（回车添加）；**留空则由 AI 拆解时补全建议稿** |
| 工作区 | 否 | 路径选择器（复用宿主目录选择能力）；缺省 = 宿主默认工作区 |
| Agent 预设 | 否 | 下拉（宿主注册表）；缺省 = 默认预设 |
| 权限 | 否 | 下拉；缺省 = `read-only`；高于会话默认权限时创建卡片上出现琥珀色提示「执行时需确认」 |
| 拆解后自动开工 | 否 | 默认开（用户主流程：拆完即实现）；关闭则 ready 后等人工放行 |
| 迭代上限 | 否 | **默认不限（null），任务一直迭代到人工验收为止**；可选显式设置 [1,99] 作防失控开关，达限时 T7′ 暂停等人工裁决 |

**行为**：
- 创建成功 → `draft`，并按「自动拆解」配置立即 T2 或等人工点「开始拆解」。
- 创建 action 幂等：客户端生成 `requestId`，Host 去重。

### 4.2 AI 合同补全（FR-02）

- 触发：`acceptance` 为空 → 拆解会话必须先产出任务级验收建议稿，再拆子任务。
- 用户已给验收 → 拆解会话收到指令：「以下验收标准来自用户，不可删除或替换，只可细化；所有细化必须保留原条目 id 并可追溯」。
- 落库后 `sourceOfAcceptance` 如实标注；详情页对 `ai-refined` 提供「对照视图」（用户原文 vs AI 细化稿，差异高亮）。
- 用户可在 ready 前编辑 AI 稿（编辑即转 `sourceOfAcceptance: human`）。

### 4.3 AI 任务拆解（FR-03）

**机制**：复用 dsh 插件会话机制，启动一个**拆解会话**（真实 DSH 会话）：

1. 注入拆解提示（结构化模板）：任务描述 + 验收现状 + 输出契约。
2. 拆解会话通过**结构化输出协议**返回 JSON（Host 校验 schema）：

```json
{
  "taskAcceptance": [{"text": "..."}],
  "subtasks": [
    {
      "title": "修复 login 500",
      "detail": "定位到 ...，改动 ...",
      "acceptance": [{"text": "pnpm test 通过"}, {"text": "curl 返回 200"}],
      "deps": []
    }
  ]
}
```

3. Host 校验：schema 合法、`acceptance` 非空、`deps` 引用存在且无环（M2 起强制；M1 忽略 deps 仅展示）。
4. 落库为子任务卡 → 任务转 `ready` → 依 `autoStart` 决定是否 T4。
5. 拆解会话本身的 transcript 从任务详情「拆解记录」可查（留痕、可复盘）。
6. 失败重试：自动重试 1 次；再失败 → 任务 `blocked`，事件记录原因。

**人工干预**：ready 状态下子任务卡可增删改（US-04）；改动写事件（actor=human）。

### 4.4 执行引擎（FR-04/05）

- 每个子任务一轮执行 = 一个**新 DSH 会话**（保持会话一次性与可围观性；会话复用作为 M3 优化评估项，M1 不做）。
- 会话启动时由 Host 应用 `pins`（工作区/预设/权限，失败即中止——fail-closed，沿 task-board 验证过的语义），然后注入**执行合同提示**：

```
[taskflow 合同]
你在执行任务「<任务标题>」的子任务「<子任务标题>」。
目标：<objective + detail>
验收标准（逐条，完成后必须逐条自证）：
  ac_1: ...
  ac_2: ...
上一轮打回批语（如有）：<round-1 批语 + 上轮证据引用>
完成或无法完成时，必须调用 taskflow.submit_evidence 工具提交证据；
无法继续时调用 taskflow.report_blocker 说明原因。
```

- **agent 侧工具面**（通过宿主工具注册机制提供，仅对 taskflow 启动的会话暴露）：
  - `taskflow.submit_evidence(changesSummary, verification[], selfCheck[])` —— 提交证据；Host 校验 `selfCheck` 与 `acceptance` 逐条对应，缺条拒收；
  - `taskflow.report_blocker(reason)` —— 报障：子任务转 blocked，事件记录；
  - `taskflow.update_progress(note)` —— 进度便签，仅入事件流不转状态。
- 调度循环：子任务 pending→in-progress 由调度器驱动（依赖就绪 + WIP 未满）；同一任务默认串行（M1），M2 放开 DAG 并行。
- 会话意外终止（宿主重启等）：重启恢复时「有会话记录的运行」标记观察、无记录的取消——沿 task-board 已验证的确定性恢复语义。

### 4.5 完成证明 Evidence（FR-06）

三要素（缺一不可，Host 强制）：

| 要素 | 内容 | 来源 |
|---|---|---|
| changesSummary | 本轮做了什么、改了哪里 | agent 撰写 |
| verification[] | 至少 1 条验证记录：label + 输出摘录（≤8KiB/条）+ passed | agent 运行命令的输出 |
| selfCheck[] | 与 acceptance **等长**，逐条 pass/partial/fail + 说明 | agent 对照撰写 |

附加 refs：产出会话 id、diff 统计。UI 上证据以「验收报告卡」呈现，selfCheck 逐条对照渲染（ac_1 ↔ selfCheck[0] 并排）。

**任务级终检证据（2026-09-11 语义升级）**：全部子任务证据齐备后、任务进 review（T5）前，宿主自动跑一次**终检会话**（形制同拆解：提示词输入 = 任务合同 + 全部子任务证据摘要，输出 = JSON 证据），对照**任务级验收标准**逐条核验整体交付，落库 `task.evidence`（复用 Evidence 三要素，selfCheck 与任务级验收标准等长对应）。终检期间任务保持 in-progress（卡片可见终检标记）；失败自动重试 1 次，仍失败则**兜底**：无任务级证据直接进 review（子任务证据作为验收材料），人工可随时「补跑 AI 终检」（`generateTaskEvidence`）。打回迭代时任务级证据作废，子任务重新齐备后终检重跑。

### 4.6 人工验收（FR-07）

**核心语义（2026-09-11 拍板）：验收只对合同，过程归 AI。** 人的验收对象 = 任务合同（目标 + 任务级验收标准 + 任务级终检证据）；子任务是 AI 自己拆的执行计划，其证据只是**过程举证**，展示但不作为判定面，人不需要逐个验收，更不需要打回时选择子任务。

- **入口**：看板 review 列卡片 / 顶部「待验收」角标 / 详情弹窗验收 tab。
- **审查工作台**（详情弹窗的 review 态，2026-09-10 弹窗化 + 2026-09-11 语义重排）：居中大弹窗（≈1240×820，窄屏退化全屏），纵向两层 + 吸底操作栏：
  - 上 = **任务级判定面**：任务级终检证据卡（判定先行：自检徽章 → 逐条自检（全过折叠，有 partial/fail 自动展开）→ 变更摘要（限高 4 行可展开）→ 验证记录折叠）+ 任务级验收标准逐条对照（pass/partial/fail 徽章）；
  - 下 = **执行过程举证（n）**：默认折叠，标注「AI 执行留痕，无需逐个验收」；点开为子任务手风琴（状态点 + 自检 n/n 徽章，点行展开证据详情）；
  - 底部吸底：`✓ 验收通过（→ done）` / 打回批语（必填）/ `✗ 打回并继续迭代`——按钮不再出现任何「选中 n 个子任务」措辞。
- **批准**：任务级一键（approveTask，T6 守卫不变）；approveSubtask 仍保留为 API 能力，UI 不再暴露。
- **打回**：
  - 人只给**批语**（必填，原文注入下一轮执行）；**返工范围由 AI 定位**：引擎自动跑 triage 会话（输入 = 批语 + 子任务清单及状态摘要，输出 = `{reworkSubtaskIds, note}`），未点名的子任务保持 review 不重跑；triage 失败/结果无效/为空 → 回退**全量打回**（旧语义兜底）。显式传 `subtaskIds` 仍为 API 高级路径；
  - 动作序列：被点名的子任务 → rejected（落事件：actor=human, reason=批语）→ in-progress 重新入队；task.round+1；任务级证据作废；任务若在 review 则回 in-progress（T7）；全程留痕（`reject` / `rework-scope` 事件）；
  - 达 `maxRounds` 时打回变为「已达迭代上限」：允许「提高上限并打回」（T7′）。

### 4.7 迭代循环（FR-08）

- 轮次语义：子任务 `round` 从 1 起；每次打回 +1；卡片角标「第 n 轮」。任务级 `round` 同步 +1。
- 下一轮执行的注入 = 合同 + **批语原文** + 上轮证据摘要（引用 id，UI 可展开）。
- 跨会话文本注入一律带来源声明包装（安全模型见 §7）：「以下内容来自人类验收批语 / AI 上轮自检 / AI 执行会话产出的子任务证据，未经本会话审阅」。

### 4.8 状态历史时间线（FR-09）

- 数据：`events[]` 追加写，任何状态变化必有事件（含系统自动转移，reason 写明规则名，如 `deps-satisfied` / `evidence-complete`）。
- UI：详情抽屉「历史」标签页，垂直时间线：`── 14:32 AI · 实现中 → 待验收（证据已提交，自检 3/3 通过）`；打回事件高亮并内嵌批语；事件可跳转会话（refs.sessionId）。
- M1 范围：任务级 + 子任务级事件合并按时间排序展示。

### 4.9 看板视图（FR-10/11）

**列定义（M1 四列 + 受阻标红）**：

| 列 | 包含状态 | 卡片角标 |
|---|---|---|
| 待办 | draft / ready | 「待拆解」「第 n 轮待执行」 |
| 实现中 | decomposing / in-progress | 子任务进度点（2/5 done） |
| 待验收 | review | 证据条数 |
| 已完成 | done | 批准时间 |
| （受阻） | blocked | 不单列，原列位置置灰 + 红边 + 原因悬浮 |

**卡片信息层级**（一屏 10+ 卡不换行暴胀）：标题（1 行截断）→ 描述摘要（1 行）→ 进度条（子任务 done 比例）→ 轮次 + 最后活动时间 → 受阻/待验收强调色。

**全局**：顶部工具条 = 搜索（标题/描述/子任务）、状态过滤、工作区过滤；右上「待验收 n」角标（US-15 的 M1 形态）。

### 4.10 任务详情弹窗（FR-11）

居中大弹窗（`min(1240px, 92vw) × min(820px, 90vh)`；≤760px 或矮屏退化全屏；Esc / 点遮罩 / ✕ 关闭，Tab 焦点陷阱，关闭后焦点还给打开者）。任务级操作（取消/归档等）固定弹窗底部操作栏，不随内容滚动。

```
┌──────────────────────────────────────────────┐
│ 标题 · 状态徽标 · 轮次 · 审批提示        ✕     │
├──────────────────────────────────────────────┤
│ Tabs: 合同 | 子任务 | 验收 | 历史 | 拆解记录    │
│  合同：objective / acceptance（含对照视图）/ pins │
│  子任务：列表，每行状态+轮次+会话跳转            │
│  验收：审查工作台（4.6，主从双栏 + 吸底裁决栏）   │
│  历史：时间线（4.8）                            │
│  拆解记录：拆解会话 transcript 引用              │
├──────────────────────────────────────────────┤
│ 任务操作栏（开始拆解 / 确认权限 / 取消 / 归档）   │
└──────────────────────────────────────────────┘
```

---

## 5. UI/UX 规格

### 5.1 布局

- 挂载点：侧栏新增入口（宽侧栏图标+文字，窄栏仅图标）——沿 dsh 插件挂载惯例；看板为主视图。
- 看板列宽固定（280px），横向滚动；卡片间距 8px；页面留白遵循 8px 网格。

### 5.2 视觉设计原则（「好看」的落地标准）

1. **主题变量接入**：全部颜色使用宿主主题变量（`--dsw-alias-*` 体系），浅色/深色自动适配，禁止任何硬编码色值；语义色只允许用于状态（受阻红、待验收琥珀、完成绿、进行中蓝）。
2. **排版**：系统字体栈与宿主一致；标题/正文/辅助字三级字阶；数字等宽（tabular-nums）显示轮次与计数。
3. **动效克制**：仅三类——卡片 hover 抬升（translateY 1px + 阴影）、弹窗浮现（180ms 轻缩放位移）、状态变更的徽标脉冲一次；全部动效尊重 `prefers-reduced-motion`。
4. **三态完整**：加载态用骨架屏（列骨架 + 卡片骨架，禁止一行文字打发）；空态给插画级引导（「创建第一个任务」+ 示例按钮）；错误态给重试按钮 + 原因。
5. **无障碍**：全控件 `:focus-visible` 焦点环；看板列 `role="list"`、卡 `role="listitem"`；角标 `role="status"`；点击区域 ≥ 24×24px；色彩对比度 ≥ 4.5:1。
6. **密度**：默认舒适密度；不做紧凑模式（YAGNI）。

### 5.3 交互细节

- 所有变更操作乐观 UI **禁用**（Host 权威 + revision 快照模型，避免状态分叉）；提交后按钮 loading，返回快照后整卡刷新。
- 危险操作（取消、归档、提高迭代上限）二次确认，确认框写明后果。
- 断线：SSE 断开时顶部细条提示「实时同步已断开，正在重连」，重连成功自动消失；重连后拉全量快照。

---

## 6. API 与协议草案

同源端点（挂载于宿主 webserver，均要求浏览器同源标记；POST 要求 JSON；沿 task-board 验证过的安全形态）：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/taskflow/state` | GET | 全量带 revision 快照 |
| `/api/taskflow/events` | GET (SSE) | 推送 revision / 调度 / 通知变化 |
| `/api/taskflow/action` | POST | 幂等 action 提交（requestId 去重；≤64KiB） |

**Action 联合类型（白名单，无命令/路径/参数类字段）**：

```
createTask          开始Decompose(startDecompose)    updateContract
editSubtasks        startImplementation             approveSubtask
rejectSubtask       approveTask                     cancelTask
archiveTask         retryBlocked                    raiseMaxRounds
```

**Agent 工具协议**（会话内）：`taskflow.submit_evidence` / `taskflow.report_blocker` / `taskflow.update_progress`，经宿主工具注册机制暴露；仅对 taskflow 启动的会话可见；调用走 Host 校验（§4.4/§4.5）。

---

## 7. 安全与权限

1. **权限确认门**：`pins.permission` 高于会话默认权限（`sessionDefaultPermission`，默认 `read-only`）的任务，创建时标记「需确认」；首次执行前必须在详情页显式确认（写事件 actor=human）；`presetId`/`workspace` 变更后确认状态重置（re-arm，沿 task-board 语义）。
2. **执行三元组 fail-closed**：工作区不存在 / 预设缺失 / 权限命令被拒 → 提示词**发出前**中止，子任务转 blocked。
3. **注入防护**：所有跨会话文本（打回批语、AI 拆解产物、上轮证据摘要）注入新会话时，包装来源声明模板，声明来源与「未经本会话审阅」警告。
4. **证据边界**：证据输出截断（8KiB/条）防 ledger 暴涨；selfCheck 与 acceptance 等长校验防跳条。
5. **存储**：ledger 0600；损坏文件移 `ledger.json.corrupt-*` 保留原始字节，Host 以空 ledger + 显式错误启动，绝不静默清空。

---

## 8. 错误处理策略

| 场景 | 行为 |
|---|---|
| 拆解会话失败 | 自动重试 1 次 → 仍失败：任务 blocked，事件带原因，可人工「重新拆解」 |
| 执行会话启动失败（pins 不满足） | 不发提示词；子任务 blocked；事件区分「启动失败」与「执行失败」 |
| 执行会话中途崩溃 | attempt+1 自动重启至 2 次；超限 blocked |
| submit_evidence 校验失败 | 工具调用被拒，向 agent 返回结构化修正提示（缺哪条、为什么）；不转状态 |
| ledger 写入失败 | 保留原文件；Host 返回 5xx；内存态与磁盘态以磁盘为准回滚 |
| ledger 损坏 | §7.5 语义；UI 显式错误横幅 |

---

## 9. 里程碑验收映射

| 里程碑 | 功能文档覆盖章节 |
|---|---|
| M1 | §2 数据模型 v1、§3 状态机全部 P0 转移、§4.1–4.9、§5、§6、§7、§8 |
| M2 | §3.1 T7 批量、§4.9 过滤增强、FR-12/13/14/15/16 对应扩展（DAG 调度循环、WIP、批量 action、归档视图、通知通道） |
| M3 | FR-17–20：触发器注册、AI 预审会话（独立第二会话读证据出建议，不落状态）、模板、报表 |

---

## 10. 开放问题（进入 M1 前须裁决）

| # | 问题 | 倾向 |
|---|---|---|
| Q1 | 拆解会话的模型/预设选择：跟随宿主默认 or 任务级指定 | M1 跟随宿主默认；M2 加任务级覆盖 |
| Q2 | 子任务并行度：M1 串行是否足够 | 串行（可观测性好）；DAG 并行留给 M2 |
| Q3 | 证据中 diff 的展示深度（摘要 vs 内嵌渲染） | M1 摘要 + 会话跳转；M2 评估内嵌 |
| Q4 | 任务级「一次性批准全部子任务」是否进 M1 | 进（review 页主按钮），子任务级批量为 M2 |
| Q5 | npm 最终包名 `dsh-taskflow` 查重 | 发布前执行，冲突则备选 `dsh-taskflow-board` |
