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
- 调度循环：子任务 pending→in-progress 由调度器驱动。**依赖 DAG 就绪守卫（FR-12，2026-09-15 起默认开）**：直接依赖「产物已存在」（`done` 或 `review`=举证完毕——2026-09-11 语义下子任务不再逐个人批，按 `done` 判定 DAG 必然死锁）才可调度；未知 dep 引用视为未满足（fail-closed）；**前序被打回时下游回退**：返工集沿 deps 传递闭包回退下游——运行中的终止会话（摘存活表+卸看门狗+过期审批+适配器取消）、举证完毕（review）的作废证据重排；`done` 下游不自动作废（人工已批准），任务级留「建议人工复核」提示，传播穿过 done 中间节点继续；未牵连的独立分支不动。plugin config `enforceDeps: false` 仅用于旧数据人工排障。
- **WIP 并发上限（FR-13，2026-09-15）**：全局设置 `maxConcurrentSubtasks`（1–8，settings.json 持久化，覆盖引擎配置基线默认 1=串行）；提高即改即生效（立即放行排队中的子任务），降低不杀运行中的会话（不再发新车，自然收敛）。队列可视化：子任务列表「等依赖：X / 排队中」chip。
- 会话意外终止（宿主重启等）：重启恢复时「有会话记录的运行」标记观察、无记录的取消——沿 task-board 已验证的确定性恢复语义。

### 4.5 完成证明 Evidence（FR-06）

三要素（缺一不可，Host 强制）：

| 要素 | 内容 | 来源 |
|---|---|---|
| changesSummary | 本轮做了什么、改了哪里 | agent 撰写 |
| verification[] | 至少 1 条验证记录：label + 输出摘录（≤8KiB/条）+ passed | agent 运行命令的输出 |
| selfCheck[] | 与 acceptance **等长**，逐条 pass/partial/fail + 说明 | agent 对照撰写 |

附加 refs：产出会话 id、diff 统计。UI 上证据以「验收报告卡」呈现，selfCheck 逐条对照渲染（ac_1 ↔ selfCheck[0] 并排）。

**任务级终检证据（2026-09-11 语义升级）**：全部子任务证据齐备后、任务进 review（T5）前，宿主自动跑一次**终检会话**（形制同拆解：提示词输入 = 任务合同 + 全部子任务证据摘要，输出 = JSON 证据），对照**任务级验收标准**逐条核验整体交付，落库 `task.evidence`（复用 Evidence 三要素，selfCheck 与任务级验收标准等长对应）。终检期间任务保持 in-progress（卡片可见终检标记）；失败自动重试 1 次，仍失败则**兜底**：无任务级证据直接进 review（子任务证据作为验收材料），人工可随时「补跑 AI 终检」（`generateTaskEvidence`）；review 态已有任务级证据时同一入口变为「**重跑 AI 终检**」——原证据立即作废、终检成功后以新证据替代（终检结论或交付物口径不对时的人工纠偏入口，2026-09-11 下午补）。打回迭代时任务级证据作废，子任务重新齐备后终检重跑。（2026-09-11 下午修：补跑（review 态）失败后的自动重试曾被 in-progress 状态守卫静默吞掉——重试起点现对两态一视同仁，且拒收的真实 problems 完整进事件留痕，不再只剩通用文案首行。）

**交付物声明 artifacts（§4.5b，2026-09-11 补）**：证据可带可选 `artifacts?: Artifact[]`（`{path 绝对路径, description, howVerified}`，≤20 条；2026-09-11 下午由 10 上调——真机任务多子报告交付可达 12 项，10 会误伤合法终检）——结构化指认**产物本体**，回答「产物是什么、在哪、内容是什么」；此前交付物只是 changesSummary 自由文本里的路径碎片，验收台看不到也不可预览。约定（层级口径 2026-09-11 下午拍板：**验收栏只放最终产物，中间产物归子任务**）：
- **终检只声明核心交付物**：任务级只声明「验收人终审要看的最终产物本体」（通常 1~3 项，如汇总/最终报告；终检本就只读核验，顺手 stat 确认存在性），验收台任务级判定面顶部「交付物（n）」区只出现这些——先看产物，再看判定；过程性中间产物、支撑数据、明细文件**一律不进任务级清单**；
- **中间产物归子任务举证**：执行会话经 `taskflow_submit_evidence` 的可选 artifacts 参数声明（最终产物与中间产物/支撑数据都算），只在过程举证折叠区展示，不进验收栏；
- **只读预览（§7.4b）**：验收台每条交付物可「预览」——宿主只读读取文本头部（≤256KiB，超出标记截断；头部 8KiB 含 NUL 判二进制拒显），以**受限 Markdown 渲染**（React 元素表达、无 HTML 注入面，链接仅 http/https/#）直接在弹窗内查看产物，不用离开看板翻文件；
- **加性变更**：artifacts 可选，旧 ledger 无此字段的证据照常工作。

### 4.6 人工验收（FR-07）

**核心语义（2026-09-11 拍板）：验收只对合同，过程归 AI。** 人的验收对象 = 任务合同（目标 + 任务级验收标准 + 任务级终检证据）；子任务是 AI 自己拆的执行计划，其证据只是**过程举证**，展示但不作为判定面，人不需要逐个验收，更不需要打回时选择子任务。

- **入口**：看板 review 列卡片 / 顶部「待验收」角标 / 详情弹窗验收 tab。
- **审查工作台**（详情弹窗的 review 态，2026-09-10 弹窗化 + 2026-09-11 语义重排）：居中大弹窗（≈1240×820，窄屏退化全屏），纵向两层 + 吸底操作栏：
  - 上 = **任务级判定面**：任务级终检证据卡（**交付物区先行**：产物本体路径 + 说明 + 核验方式 + 只读预览（§4.5b），其次判定：自检徽章 → 逐条自检（全过折叠，有 partial/fail 自动展开）→ 变更摘要（限高 4 行可展开）→ 验证记录折叠）+ 任务级验收标准逐条对照（pass/partial/fail 徽章）；
  - 下 = **执行过程举证（n）**：默认折叠，标注「AI 执行留痕，无需逐个验收」；点开为子任务手风琴（状态点 + 自检 n/n 徽章，点行展开证据详情）；
  - 底部吸底：`✓ 验收通过（→ done）` / 打回批语（必填）/ `✗ 打回并继续迭代`——按钮不再出现任何「选中 n 个子任务」措辞。
- **批准**：任务级一键（approveTask，T6 守卫不变）；approveSubtask 仍保留为 API 能力，UI 不再暴露。
- **打回**：
  - 人只给**批语**（必填，原文注入下一轮执行）；**返工范围由 AI 定位**：引擎自动跑 triage 会话（输入 = 批语 + 子任务清单及状态摘要，输出 = `{reworkSubtaskIds, note}`），未点名的子任务保持 review 不重跑；triage 失败/结果无效/为空 → 回退**全量打回**（旧语义兜底）。显式传 `subtaskIds` 仍为 API 高级路径；
  - 动作序列：被点名的子任务 → rejected（落事件：actor=human, reason=批语）→ in-progress 重新入队；task.round+1；任务级证据作废；任务若在 review 则回 in-progress（T7）；全程留痕（`reject` / `rework-scope` 事件）；
  - 达 `maxRounds` 时打回变为「已达迭代上限」：允许「提高上限并打回」（T7′）。
- **批量验收（FR-14，2026-09-15）**：看板「批量操作」模式可勾选待验收卡（及已完成/已取消卡）——「通过所选（n）」两段式确认后逐个 `approveTask`；「打回所选（n）」用**共用批语**（必填，空批语禁用确认）逐个打回（不点名范围，走 AI triage）；「归档所选（n）」同 2026-09-12 语义。三动作均只作用于各自可用子集（勾选后状态变化不误伤），复用单任务引擎守卫，失败计数入横幅。

### 4.7 迭代循环（FR-08）

- 轮次语义：子任务 `round` 从 1 起；每次打回 +1；卡片角标「第 n 轮」。任务级 `round` 同步 +1。
- 下一轮执行的注入 = 合同 + **批语原文** + 上轮证据摘要（引用 id，UI 可展开）。
- 跨会话文本注入一律带来源声明包装（安全模型见 §7）：「以下内容来自人类验收批语 / AI 上轮自检 / AI 执行会话产出的子任务证据，未经本会话审阅」。

### 4.8 状态历史时间线（FR-09）

- 数据：`events[]` 追加写，任何状态变化必有事件（含系统自动转移，reason 写明规则名，如 `deps-satisfied` / `evidence-complete`）。
- UI（**2026-09-21 三期改版：独立「历史」tab 退役**）：历史内嵌到「流程」tab（§4.17）——点击流程图节点（子任务卡 / 阶段药丸）在图下方展开**该节点**的轨迹面板：升序时间线（最新在末尾），执行中的节点（子任务有运行会话 / 相位运行中）面板**钉底实时滚动**（AI 进度便签经 SSE 逐条追加），已完成的显示静态条数。事件按相位分流：拆解相关 → 拆解面板；终检相关 → 终检面板；**其余任务事件 → 终批面板兜底**（零盲区）。打回事件高亮并内嵌批语；事件可跳转会话（refs.sessionId）。
- 节点可点：鼠标点击 + 键盘可达（role=button、Enter/Space），选中节点描边加粗高亮。

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

**子任务进度的 §4.6 口径（2026-09-11 下午补）**：卡片「n/m 子任务」与进度条的分子 = `done + review`（§4.6 后子任务不再逐个人验，`review` = 执行举证完毕、随任务终审一并定案）——否则终检就绪的任务卡片会显示「0/12 子任务」，像什么都没做。子任务状态标签 `review` 同步改读「举证完毕」（原「待验收」），消除「子任务也等人验收」的误导。

**全局**：顶部工具条 = 搜索（标题/描述/子任务）、状态过滤、工作区过滤；右上「待验收 n」角标（US-15 的 M1 形态）。

**浏览器通知（FR-16，2026-09-15）**：shell 级常驻 watcher（看板关着也要能响）——SSE 快照 diff 检测「新进 review 的任务」与「新发起的 pending 审批」发系统通知；首帧只建基线不补发；用户 opt-in（工具栏 🔔，偏好存 localStorage，开启时请求权限，denied 给提示）；点击通知 → 聚焦窗口 + 打开看板定位对应任务/审批卡（复用通知栏「去处理」管线）；环境不支持 Notification 时整体退化（角标/通知栏仍是兜底）。

### 4.10 任务详情弹窗（FR-11）

居中大弹窗（`min(1240px, 92vw) × min(820px, 90vh)`；≤760px 或矮屏退化全屏；Esc / 点遮罩 / ✕ 关闭，Tab 焦点陷阱，关闭后焦点还给打开者）。任务级操作（取消/归档等）固定弹窗底部操作栏，不随内容滚动。

```
┌──────────────────────────────────────────────┐
│ 标题 · 状态徽标 · 轮次 · 审批提示        ✕     │
├──────────────────────────────────────────────┤
│ Tabs: 合同 | 流程 | 子任务 | 验收 | 产物 | 拆解记录 │
│  合同：objective / acceptance（含对照视图）/ pins │
│  流程：任务管线执行图 + 点节点的轨迹面板（4.8/4.17，│
│       执行中默认落点；原「历史」tab 并入此处）    │
│  子任务：列表，每行状态+轮次+会话跳转            │
│  验收：审查工作台（4.6，主从双栏 + 吸底裁决栏）   │
│  产物：任务级交付物独立呈现（done 默认落点）      │
│  拆解记录：拆解会话 transcript 引用              │
├──────────────────────────────────────────────┤
│ 任务操作栏（开始拆解 / 确认权限 / 取消 / 归档）   │
└──────────────────────────────────────────────┘
```

---

### 4.11 触发器（FR-17，2026-09-15）

- **cron 定时建卡**：plugin config `schedules: [{ id?, cron, title, description?, acceptance?, objective?, pins?, autoStart?, maxRounds? }]`——标准 5 字段（分 时 日 月 周），支持通配/步长/区间/列表及组合，日/周均受限时任一命中（标准语义）。到点自动 `createTask`（复用拆解-执行-验收主流程 = 无人值守：定时建卡 → 自动推进 → 等验收）；同一 (scheduleId, minute) 只发一次 + 幂等 requestId（`sched_<id>_<epochMinute>`）双保险，重启不重发；配置错逐条告警跳过，不拖垮宿主与定时器。
- **webhook 建卡**：plugin config `webhookToken` 设置后，`POST /api/taskflow/hook`（同源信任围栏照常）须带 `?token=` 或 `x-taskflow-token` 头（不符 403）；载荷白名单挑拣（title/description/objective/acceptance/pins/autoStart/maxRounds）后走 createTask（引擎幂等 + 形状校验）——CI/脚本可远程建卡。
- **file-watch 裁决不做**：watcher 面与去抖语义复杂，单用户场景价值最弱（cron + webhook 已覆盖无人值守建卡），确有需要再评估。

### 4.12 模板库（FR-19，2026-09-15）

- 存储：`dataDir/templates.json`（与 ledger/settings 并列），fail-closed 校验（id 形状/去重/字段白名单/≤50 条）；首次运行播种 4 个内置模板（修 Bug / 新功能 / 技术调研 / 清理整理，均带可检验验收标准草案）；损坏回退种子。API：GET/PUT `/api/taskflow/templates`（全表覆盖，先校验后落盘）。
- 创建抽屉：顶部模板 chip 行（点选预填描述/验收/执行模式，悬浮可预览验收标准）；✕ 两段式删除；「把当前表单存为模板」内联命名保存（存标题/描述/验收/执行模式）。模板口缺失（旧 bundle 混装）静默隐藏，创建流程不受影响。定位：创建 30 秒内完成（§9 成功指标）的助推。

### 4.13 周期统计（FR-20，2026-09-15）

- 工具栏柱状图标 → 只读统计浮层（Esc/点外关闭）。指标：近 7/30 天吞吐（按任务级 done 事件分桶，归档的 done 仍计入——曾经完成过）、累计完成、进行中、一次通过率（done 且 round=1 占比）、平均迭代轮次（done 任务 round 均值）、拆解采纳率（拆解后未发生 editSubtasks 的任务占比）、被打回过的任务数。
- 口径诚实：空账本比率显示「—」（不编造 0%）；每个指标的口径说明与数字同屏（浮层脚注），直接对齐 §9 成功指标（一次通过率 / 收敛轮次 / 拆解采纳率）。

### 4.14 工作区域钉定（FR-21，2026-09-20）

- 创建时可指定「工作目录」（`pins.workspace`，绝对路径，留空 = 宿主默认工作区）；模板（FR-19）可保存/预填该字段。
- 硬约束：adapter 把 workspace 写入会话 `meta.cwd`（`src/host/dsh/adapter.ts`，fail-closed：目录不存在即报错）；DSH 文件沙箱的 workspace-write 可写根随会话 cwd 钉定——AI 的一切文件改动被限定在该目录内。
- 软约束：拆解 / 执行 / 任务级终检提示词注入「工作区域条款」（`workspaceClause`，`src/host/prompts.ts`）——非必要不得改动区域外文件，确需区域外操作须先向用户说明理由。
- 展示：任务详情合同卡显示工作目录（带「改动钉定区域」标注）；打回迭代 / 终检 / triage 会话统一走 `createAgent`，自动继承。
- 目录选择器：`GET /api/taskflow/dirs?path=`（只读列出子目录，跳过隐藏目录，上限 200，非法/不可读 400）；创建表单为「选择而非填写」——只读展示 + 下拉浏览（上级/下钻/选这个目录），不留自由文本入口。
- 新建界面（2026-09-20 二次改版）：侧栏抽屉 → 居中大弹窗 + **Bento 单列**（任务 / 执行两格）；提交门禁禁用时显示原因。

### 4.15 能力预设（FR-22，2026-09-20）

- 创建表单不提供「模板」的文字编辑能力，改为预制 4 个**能力**chip：修 Bug（bugfix）/ 新功能（feature）/ 技术调研（research）/ 清理整理（cleanup），单选可取消。
- 选定后**只进后台**：`createTask.capability` 落库为 `Task.capability`（可选字段，存量任务兼容），拆解提示词注入对应口径（`capabilityDirective`，`src/host/prompts.ts`）——怎么拆、验收标准往哪个方向起草；正文/验收编辑框不出现任何预设文字。
- 校验：`capability` 必须在 `CAPABILITIES` 白名单内（`src/protocol/actions.ts`），否则 ActionFormatError。
- FR-19 模板库后端（templates.json / 路由）保留但创建表单不再使用。

### 4.16 任务级覆盖：并发数 / 模型（FR-23/FR-24，2026-09-20）

- **并发数（FR-23）**：创建表单数字输入（默认 = 全局设置当前值，1–8 白名单校验）→ `Task.maxConcurrentSubtasks`；调度器实际取 **min(全局上限, 任务级上限)**，只影响该任务内子任务的并行度，不突破全局 WIP。
- **模型（FR-24）**：创建表单下拉（数据源既有 `GET /api/taskflow/models` 目录，按 provider 分组，同全局设置浮层形态），默认「跟随全局设置」；选定后落 `Task.model`，该任务的拆解 / 执行 / 终检会话都用它，不随全局两槽。
- 子 agent 预设（agentPresets）经核实非需求所指：`GET /api/taskflow/presets` 投影保留（兼容宿主 async `list()`、过滤 broken），但创建表单与全局设置不再使用；`defaultPresetId` 设置项保留校验（向后兼容）。

### 4.17 子任务 DAG 流程图（FR-12 可视化，2026-09-21；同日二期：任务管线相位）

- 任务详情弹窗新增**「流程」tab**（合同之后、子任务之前）；**in-progress 任务的默认落点**改为流程 tab（review/done 的验收页/产物页落点不变）——点开执行中的任务第一眼就是正在跑的依赖流程。
- **任务管线相位（二期）**：图为完整生命周期 `AI 拆解 → 子任务 DAG → AI 终检 → 人工终批`——首尾三个**药丸相位节点**（`dagPhases` 纯投影，`view.ts`）：拆解（decomposing = 琥珀呼吸；跑过拆解会话 = 完成）、终检（`finalizeSessionId` = 运行中；任务级证据产出或任务终态 = 完成）、终批（review = 蓝待人；done = 绿通过；cancelled = 红已取消）。相位连线：拆解 → 各根子任务（无子任务时直连终检）、叶子 → 终检 → 终批；拆解完成后相位边转绿淡化，终检运行中入边蓝色流动。子任务层整体右移一层。**拆解中不再是空占位**——头节点药丸呼吸即「正在拆解」。
- 数据零新增：相位状态（`task.status` / `decomposeSessionIds` / `finalizeSessionId` / `evidence`）与 `Subtask.deps` + `status` 本就在每次快照里，SSE `change` 每推一次整图重渲染，实时性与看板列同源同频。
- 布局：`dagLayout`（`src/client/view.ts` 纯投影）——最长路径分层（`layer(v)=max(layer(dep))+1`），同层按拆解顺序纵排，左→右贝塞尔连线；孤儿 dep 画红虚线桩（防御展示，不参与分层）；add/edit 已校验无环，仍做收敛防御（异常环边不崩、布局退化有界）。
- 子任务节点 = 圆角卡（状态点 + 标题 + 状态/等待行 + 轮次角标）：状态色语言对齐 `StatusDot`——执行中琥珀描边**呼吸**（`tf-dag-breathe`）、待核验蓝、完成绿（填充淡化）、受阻红、等待灰虚线框；等待行复用 `subtaskWait`（等依赖：列出阻塞者 / 排队中）。指向运行中会话的连线为蓝色**虚线流动**（`tf-dag-dash`）；`prefers-reduced-motion` 下动画均关闭。
- 降级：平铺无依赖 = 单层状态条；未拆解 = 三药丸骨架（拆解待开始/运行中）；图超宽容器横向滚动；节点/连线 `<title>` 原生 tooltip（全称 + 等待原因）。
- 无新增依赖（不引 dagre 等）：每任务子任务量级（通常 <20）手写分层足够，且布局纯函数可单测（`test/unit/view.test.ts`：分层/孤儿 dep/环防御/相位投影/截断）；渲染冒烟在 `test/client/render.test.ts`（含相位药丸与管线连线断言；夹具 EventSource 模拟已改为常驻监听语义，SSE 实时性真实生效）。
- **节点轨迹面板（三期，2026-09-21）**：节点可点（鼠标 + 键盘 Enter/Space，role=button，选中描边加粗）→ 图下方展开该节点轨迹（§4.8）：`subtaskTimeline`（子任务事件升序）/ `phaseTimeline`（任务事件按相位分流，终批兜底零盲区）；执行中面板**钉底实时滚动**（`scrollTop` 跟随，jsdom 兼容），已完成显示静态条数。独立「历史」tab 移除，`mergedTimeline` 退役。

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
| `/api/taskflow/settings` | GET | 全局设置（模型两槽 + `maxConcurrentSubtasks` 并发上限，FR-13；并发返回生效值 = 设置值 ?? 引擎配置） |
| `/api/taskflow/settings` | PUT | 覆盖全局设置（fail-closed 形状校验；**先落盘后生效**，落盘失败 500 且不改引擎内存——2026-09-15 修复此前只改内存不落盘、重启即失） |
| `/api/taskflow/models` | GET | 宿主模型目录投影（下拉数据源；未注入提供方 501） |
| `/api/taskflow/artifact/preview` | GET | 交付物只读预览（§4.5b/§7.4b；query: `taskId` + `path`；只放行该任务证据声明过的路径） |

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
6. **交付物预览（§7.4b，2026-09-11 补）**：`artifact/preview` 是**ledger 白名单只读口**——只放行该任务证据 artifacts 声明过的路径（精确字符串匹配），未声明路径一律 404，不是任意文件读取口；只读（open(r)/stat，从不写）；单次 ≤256KiB 截断；头部含 NUL 判二进制拒显；渲染走 React 转义（无 HTML 注入面），链接仅放行 http/https/#。同源信任围栏沿 §6 形态（loopback/受信主机 + 同源 Origin）。已知边界：声明→预览之间的 TOCTOU 与符号链接替换不设防——验收人手动触发、单用户本机、同权限运行，风险可接受。
7. **提权审批应答（§7.1b，2026-09-22 真机事故修复）**：沙箱提权（写工作区外等）走宿主 `approval/request` waterfall。事故形态：仅挂 agent setup ctx 的应答器在当前宿主上收不到派发——完全权限（auto）任务的提权请求无人应答，会话**静默挂死**（审批不落账本、GUI 不弹、看板无感知），30 分钟后被看门狗误判「静默超时」击杀。修复双保险：① 应答器同时挂**插件根 ctx**（dsh-acp 同款形态）+ 运行中会话所有权表过滤（auto 秒放行 / approval 进引擎审批桥落库看板）；② **auto + 未钉工作区的会话直接以 `danger-full-access` 预设创建**（create 与 adopt 两路）——提权询问从根上消失，「完全权限」名副其实；**钉了工作区**的任务保持 workspace-write（FR-21 硬约束不因完全权限失效），提权改经应答器即时放行、逐次留痕。

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
| M2 | §3.1 T7 批量、§4.9 过滤增强、FR-12/13/14/15/16 对应扩展——**2026-09-15 全部落地**：DAG 调度守卫与依赖回退（§4.4）、WIP 并发上限与队列可视化（§4.4/§6）、批量验收（§4.6）、归档/搜索（2026-09-12）、通知（角标 + 审批通知栏 + 浏览器通知，§4.9） |
| M3 | FR-17–20 **2026-09-15 落地**：cron 定时建卡 + token 门 webhook 建卡（§4.11；file-watch 裁决不做）、AI 预审（**口径裁决：任务级终检（§4.5）已实质覆盖「第二会话独立复核证据、产出建议、不代替人判」——终检会话即独立复核，人终批即最终判定；FR-18 关闭**）、模板库（§4.12）、报表（§4.13） |

---

## 10. 开放问题（进入 M1 前须裁决）

| # | 问题 | 倾向 |
|---|---|---|
| Q1 | 拆解会话的模型/预设选择：跟随宿主默认 or 任务级指定 | M1 跟随宿主默认；M2 加任务级覆盖 |
| Q2 | 子任务并行度：M1 串行是否足够 | 串行（可观测性好）；DAG 并行留给 M2 |
| Q3 | 证据中 diff 的展示深度（摘要 vs 内嵌渲染） | M1 摘要 + 会话跳转；M2 评估内嵌 |
| Q4 | 任务级「一次性批准全部子任务」是否进 M1 | 进（review 页主按钮），子任务级批量为 M2 |
| Q5 | npm 最终包名 `dsh-taskflow` 查重 | 发布前执行，冲突则备选 `dsh-taskflow-board` |
