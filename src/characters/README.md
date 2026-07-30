# @ema-agent/character-card

> EmaAgent 的角色卡领域模型 —— 管理角色数据、SQLite 持久化，以及角色身份与表达能力的模型可见投影。
> 本包不依赖 HookBus，也不装配完整 System Prompt；它只把自己的角色语义输出为明确片段。

---

## 整体架构

```
                    ┌─────────────────────────┐
    Controller /    │   CharacterCardStore    │
    CLI / API  ────►│                         │
                    │  ┌───────────────────┐  │
                    │  │ activate(id)      │  │
                    │  │ create(input)     │  │
                    │  │ list()            │  │
                    │  │ get(id)           │  │
                    │  │ update(id, patch) │  │
                    │  │ duplicate(id)     │  │
                    │  └───────┬───────────┘  │
                    │          │               │
                    │  ┌───────▼───────────┐  │
                    │  │ Card / Resources  │  │
                    │  │ SQLite Repos      │  │
                    │  └───────────────────┘  │
                    └─────────────────────────┘
```

模块提供：

- **纯数据抽象**：不包含特定的应用层逻辑或事件发射器。
- **SQLite 持久层外观**：基于 `@ema-agent/storage` 提供的数据库接口进行操作封装。
- **显式资源聚合**：角色定义与 Live2D 变体、立绘、参考音频分别持久化，由 Store 返回统一角色投影。
- **安全 CRUD**：包括激活策略、内置角色种子的初始化、资源主项切换和数据库外键约束。

---

## 文件结构

```
src/
├── index.ts             # 入口，统一导出
├── store.ts             # 聚合角色定义和三类资源，提供领域 API
├── repository.ts        # 角色卡核心字段的 SQLite 适配
├── types.ts             # 角色卡聚合类型
├── live2d/              # Live2D 变体类型与仓储适配
├── portraits/           # 角色图片类型与仓储适配
├── voiceReferences/     # 参考音频类型与仓储适配
├── characterPrompt.ts   # 角色身份与 ACT 表达能力的模型可见片段
└── seed/                # 内置角色定义与显式资源种子
tests/
└── store.spec.ts      # Vitest 单元测试
```

---

## 核心设计要点

### 1. 彻底与 HookBus 解耦
在最初的设计中，角色卡的切换或状态修改会向 `HookBus` 发送触发事件。为了遵守**关注点分离**（Separation of Concerns），`store.ts` 将所有副作用剥除，不再依赖 `@ema-agent/hook`。角色卡切换相关的事件（如 `onCharacterCardSwitch`）交由消费此包的上层（例如 App 层）以回调或 emitter 的形式分发。`activate(id)` 现在是一个纯粹的同步操作，直接返回激活的 `CharacterCardId`。

### 2. 角色语义与 Prompt 装配分离
`characterPrompt.ts` 负责把 `systemPrompt`、`emotionVocabulary` 和 `motionVocabulary` 转成 Character Identity 与 Presentation 片段，因为这些语义属于角色。完整 Slot 排序、版本快照和 System Prompt 序列化仍由 **`@ema-agent/prompts`** 处理；Character 不读取其他上下文，也不修改消息数组。

### 3. 角色定义与资源分表
`character_cards` 只保存角色身份和 Prompt 等核心字段。Live2D、图片与参考音频各自拥有明确资源表，并通过 `character_card_id` 外键归属角色。这样可以保存多个候选资源、确定主资源，又不会把路径数组塞回万能 JSON。

复制角色只复制角色定义，不共享原角色的资源路径；资源复制、导入和删除将在可恢复文件生命周期中单独完成。

---

## `CharacterCardStore` API 概览

| 方法签名 | 说明 |
|---|---|
| `ensureSeed(): void` | 初始化检查，若内置角色（EMA）不存在则插入；若当前无激活卡则默认激活 EMA。 |
| `current(): CharacterCard` | 获取当前正在处于“激活”状态的角色卡对象，缺失则抛出异常。 |
| `list(): CharacterCard[]` | 枚举数据库中所有的角色卡列表。 |
| `get(id: CharacterCardId): CharacterCard \| undefined` | 根据 ID 检索指定的角色卡。 |
| `activate(id: CharacterCardId): CharacterCardId` | 同步激活目标角色卡并返回其 ID，若 ID 不存在引发 `Error`。 |
| `create(input: CharacterCardInput): CharacterCard` | 接收表单输入并插入到数据库。 |
| `update(id: CharacterCardId, patch: Partial): CharacterCard` | 对指定的角色卡执行局部更新。 |
| `duplicate(id: CharacterCardId): CharacterCard` | 克隆角色定义并生成 “(Copy)” 记录，不复制原角色资源路径。 |
| `delete(id: CharacterCardId): void` | 硬删除指定的角色卡信息。 |
