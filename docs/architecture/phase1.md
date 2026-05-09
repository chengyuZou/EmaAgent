# Phase 1: 核心存储与状态管理层 (Core Storage)

## 1. 阶段目标与背景 (Goals)
*简单描述本阶段的任务，比如：将原先散落在 Python 中的 JSON 文件存储替换为强类型的 SQLite 方案。*
按这个顺序，严格不跳步：

# 从哪里开第一刀

按"**纵向跑通最小 chat 链路**"原则，不要先把所有底座包都铺平再上层——那是经典烂尾路径。先打通一根线，再左右扩。

---

## Phase 1 · 地基（先 1~2 天，目标：能起进程能 curl /health）

按这个顺序，**严格不跳步**：

| 序 | 干什么 | 完工标准 |
|---|---|---|
| 1 | Monorepo 脚手架 | `pnpm-workspace.yaml` / `turbo.json` / `tsconfig.base.json` / 根 `package.json`。`pnpm install` 不报错 |
| 2 | `packages/contracts` | 只定义 brand IDs（TurnId/SessionId/...）+ `EmaStreamEvent` 联合类型骨架 + ErrorCode。**零运行时依赖** |
| 3 | `packages/storage` | `Database` 类 + 一个迁移文件 `001_initial.sql`（只建 `sessions` / `turns` / `messages` / `character_cards` / `settings` 五张，剩下的等用到再加）+ 对应 5 个 Repo |
| 4 | `packages/hook` | `HookBus` 实现，能注册能触发能返回 abort/replace/continue |
| 5 | `apps/core` 骨架 | Hono server + `auth.ts`（X-Ema-Secret 中间件，支持 dev 模式 bypass）+ `GET /health` + `wiring.ts` 雏形（暂时只装 Database + HookBus） |

**第一刀就是第 1 件——monorepo 脚手架**。但**真正的代码起点是第 2 件 `packages/contracts`**——因为它零依赖、最容易写、写完之后所有人都能 import 它，也是你测自己 monorepo 配置（`.js` import 扩展、NodeNext、turbo build 顺序）有没有装对的最小验证物。

阶段验证：`pnpm dev` 能起 ema-core，`curl http://localhost:3421/health` 返回 `{ status: 'ok' }`。

## 2. 架构与领域模型 (Architecture & Domain Models)
*这部分最重要。列出你划分了哪些包、哪些表。推荐用 Mermaid 画个简单的 ER 图或数据流图。*
- **核心包划分**: `constants-core`, `core-types`, `storage-sql`
- **关键表结构介绍**: `sessions`, `turns`, `character_cards` 等。

## 3. 关键设计决策 (Key Design Decisions)
*记录你在重构时做出的“权衡（Trade-offs）”，这在以后回头看时最有价值。*
- **决策 1：为什么选用 better-sqlite3？** (同步 API，无 async 传染，性能好)
- **决策 2：实体 ID 为什么采用强类型别名？** (`asId<SessionId>('...')`，防参数传错)
- **决策 3：前端和后端的边界在哪里？** (跨边界统一采用 `XxxView` 视图聚合，后端只认 `XxxRecord`)

## 4. 遗留问题与待办 (Known Issues & TODO)
*记录这个阶段为了赶进度或由于前置条件不足妥协的地方。*