# @ema-agent/characters — 角色领域

EmaAgent 的角色领域:角色定义、三类表现资源(Live2D 变体 / 立绘 / 参考音频)、
全局唯一激活角色、Prompt 硬门与资源文件生命周期。本包是角色事实的唯一所有者。

## 公共接口(冻结)

```ts
CharacterCardStore          // 唯一协调入口
buildCharacterPrompt(card)  // 角色 → CharacterPrompt 投影
CharacterPromptInvalidError / CharacterResourcePathError / CharacterResourceValidationError
EMA_CARD_ID / BUILTIN_CARDS / BuiltinCharacterSeed
```

类型出口:`CharacterCard`、`CharacterCardInput`、`CharacterPrompt`、三类资源及其
Input/Patch/Import 类型、`CharacterHealth` 投影、`CharacterEvent`、资源操作与
恢复报告类型。外部只从本 `index.ts` 导入,禁止穿透内部 repository/resources/validation 文件。

## 所有权与不变量

- **全局单激活**:任何时刻至多一张 `is_active` 卡;`activate()` 在 SQL 事务内
  先清后置,切换可在任意时刻发生,不绑定 Session。`ensureSeed()` 保证内置 Ema 卡
  存在且在无激活卡时激活它;调用方不得假设"一个 Session 一个角色"。
- **Prompt 硬门**:写入(create/update)、激活(activate)、Prompt 装配
  (`buildCharacterPrompt`)三处都拒绝空白 `systemPrompt`;空 Prompt 角色不能激活、
  不能启动新 Turn。数据库被外部写坏时同样在领域边界失败,不静默降级。
- **角色定义与资源分表**:`character_cards` 只存定义;Live2D / portraits /
  voiceReferences 各自一表,外键归属角色。候选顺序由后端冻结
  (isPrimary → position → id),前端不得自行排序或扫描文件。
- **聚合装配**:`CharacterCard` 永远带齐三类资源数组;`list()` 用按卡分组的批量
  查询(4 条 SQL),不允许消费方逐卡补查。
- **激活前健康门**:Route 层激活前必须过 `inspectHealth(id).executionAvailable`;
  Store 的 `activate()` 自身只做 Prompt 硬门。

## 资源文件语义

- 资源文件走 `.imports/.trash` 同盘事务 + manifest:SQLite 提交失败原位恢复,
  崩溃残留由启动恢复按数据库事实源处理,不猜测未知目录。
- 删除一律走 `deleteManaged*`:文件进 `.trash` 与 SQL 删除同事务;裸删 SQL 行的
  接口不存在(文件会泄漏)。活动角色、内置角色拒绝删除。
- 资源相对路径过 `CharacterResourcePaths`:拒绝绝对路径、反斜杠、空段、`..` 与
  Windows 保留名,按 realpath 阻止符号链接/Junction 逃逸。Live2D 是目录资源,
  立绘与参考音频是 `portraits/`、`voiceRefs/` 下单文件;参考音频属于角色目录,
  不存在顶层 voiceRefs。
- 同一角色的资源操作严格串行(`CharacterResourceOperations`),阶段可经
  `inspectResourceOperation()` 观察。

## CharacterPrompt 投影

`buildCharacterPrompt(card)` 产出 `{ prompt, presentation }`:

- `prompt` = 角色的 `systemPrompt` 原文(人设事实,经过硬门校验);
- `presentation` = ACT 表达协议文案,由 `emotionVocabulary`/`motionVocabulary`
  生成可用标签清单。

完整 System Prompt 的顺序、哨兵切分与序列化归 `@ema-agent/prompts`;本包不读
上下文、不碰消息数组、不装配 Prompt。

## 事件

`onSwitched` / `onPresentationChanged` 是角色领域自己的事件出口(返回反注册函数);
不依赖通用生命周期总线。订阅者(前端表现层等)自行刷新,Store 不聚合跨域副作用。

## 不负责

- 不装配 System Prompt,不认识 ExecutionProfile/Narrative;
- 不管理 Session 绑定、不做多角色并存或 Team 身份;
- 完整角色便携包(card.json + 整目录导入导出、冲突策略)推到 V1 正式版,
  内测期不建半成品 Route 或空 manifest 类型;
- 媒体正文解析、Live2D 渲染、TTS 播放归各自消费方,本包只提供路径与元数据。
