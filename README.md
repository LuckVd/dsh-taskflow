# dsh-taskflow · AI 合同式任务看板

> DeepSeek Harness (dsh) Web 插件 —— 你创建任务（验收标准可给可不给），AI 自己拆解、自己实现、自己举证；人来验收，通过才算 done，不通过打回继续迭代，全过程状态留痕。

## 定位一句话

**人与 AI 之间的合同管理器**：卡片不是提示词的容器，而是一份合同（做什么 + 怎么算做完 + 准许动用什么）；看板是这块共享黑板的实时视图；调度器的职责是把「就绪的合同」喂给会话，验收人的职责是让「done」两个字有含金量。

## 与现有能力的分工

| 能力 | 层面 | taskflow 的关系 |
|---|---|---|
| `/goal` | 会话内完成驱动循环 | 不抢它的活：卡片运行时，会话内部照常用 goal |
| `/schedule` | 会话内定时提醒 | 不重叠 |
| `dsh-task-board`（第三方） | cron 作业发射器 | 独立新项目，数据目录分离，可共存；本项目吸收其教训重新设计 |

## 文档导航

| 文档 | 内容 |
|---|---|
| [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) | 需求文档：背景、定位、用户旅程、用户故事、需求清单（FR/NFR）、里程碑、风险 |
| [`docs/FUNCTIONS.md`](docs/FUNCTIONS.md) | 功能文档：概念模型、数据模型、状态机、逐项功能规格、UI/UX 规格、API 草案、安全模型 |

## 当前状态

🚧 **M1 已实现**（宿主核心 + 客户端 + dsh 集成层，71 项测试与三门禁全绿）——
见 [`docs/ACCEPTANCE-M1.md`](docs/ACCEPTANCE-M1.md)（自验收报告：逐 FR/NFR 证据与待真机复验清单）。

## 开发

```sh
npm install          # .npmrc 已带 legacy-peer-deps（dsh 包 npm peer 版本错位）
npm run typecheck    # strict 类型检查（宿主面 + 客户端面）
npm run test         # 单测 + E2E 主流程 + 客户端渲染冒烟
npm run build        # dist/ 全产物（含 dsh 客户端模块 bundle）
npm run demo         # http://127.0.0.1:4173 —— 真实引擎 + mock 会话驱动完整 UI
```

安装到 dsh 宿主（需真实宿主环境）：`dsh plugin --profile <name> add dsh-taskflow`。

### 代码地图

| 层 | 位置 | 说明 |
|---|---|---|
| protocol | `src/protocol/` | ledger schema v1、action 白名单、拆解输出/证据校验（纯 TS，零依赖） |
| host | `src/host/` | ledger 原子存储、状态机（T1–T10/S1–S6）、引擎（调度/证据门/打回迭代/恢复）、HTTP+SSE、dsh 适配器与插件入口 |
| client | `src/client/` | 看板/抽屉/验收页/时间线（React + `--dsw-alias-*` 主题变量）、纯视图模型、HTTP/SSE 传输 |
| demo | `demo/` | 真实引擎 + mock 会话适配器的可交互演示页 |

## 仓库

- GitHub：`LuckVd/dsh-taskflow`
- 未来发布形态：dsh Web 插件（npm 包），目标宿主 `dsh 0.1.2-rc.1+`
