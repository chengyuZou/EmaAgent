# Characters

[English](./README.md)

本包保存角色身份, 人设正文, 舞台类型及角色资源. `CharacterStore` 负责角色卡, 激活, 删除和通知. `live2d/store.ts`, `illustration/store.ts`, `voice/store.ts`, `stickers/store.ts` 分别处理各自的导入, 修改, 导出和删除. SQL 读写直接使用 Storage 的 Repository.

## 使用

传入已打开的 [Storage 数据库](../storage/README-zh.md) 和角色资源目录. 同一个资源目录只创建一个 Store.

```ts
import { CharacterStore, buildCharacterPrompt } from '@ema-agent/characters';

const characters = new CharacterStore(db, charactersRoot);
const character = characters.current();
const presentation = characters.inspectStagePresentation(character.name);
const sections = buildCharacterPrompt(
  character,
  presentation,
  characters.stickers.prompt(character.name),
);
```

构造函数会清理未提交的 `.staging` 文件并补算缺失的 Live2D 字节数. 导入进行中不能针对同一目录创建另一个 Store.

角色 `name` 创建后不变, 同时标识 SQL 数据, 资源目录和 Relationship Memory 目录. `displayName` 可以修改, 为空时显示 `name`. 新角色默认不激活, 舞台为空白. 内置角色同样可以编辑和删除.

Desktop Host 只在创建新 Profile 时初始化内置角色. 它先复制随包资源, Server 再调用 `initializeBuiltinCharacters()` 写入数据库. 后续启动不会恢复用户已经删除的角色.

## 文件与导入

```text
characters/
  .staging/<operationId>/
  <characterName>/
    live2d/<modelName>/
    illustration/<fileName>
    voice/<fileName>
    stickers/<fileName>
    .previews/<modelName>.png
```

名称统一为 NFC, 并在所有平台上按 Windows 文件名限制校验. 修改显示名不移动文件. 同一角色的修改依次执行, 不同角色可以并发处理.

| 资源 | 导入和选择 |
| --- | --- |
| Live2D | 支持 ZIP 和目录. 先暂存并校验模型引用, Desktop 生成 PNG 封面后再提交. 导入不会自动设为主要模型. |
| 立绘 | 检查 PNG, JPEG, GIF 或 WebP 文件头后复制原图. 可选的 expression 把图片分组, 同一组最多 10 张. |
| 参考音频 | 校验本地普通文件后复制, 同时保存音频对应的文本和语言. 最大 512 MiB, 检测时长不超过 60 秒. 导入后可修改展示名, 朗读文本和语言; 音频文件与检测时长保持不变. |

音频校验读取文件头和部分文件区间, 不会完整解码录音. 例如 MP3 时长根据首个检测到的音频帧码率估算.

Live2D 准备阶段返回 `importId`, 暂存模型不会出现在正式资源列表中. 提交时先移动模型和封面, 再插入 SQL 行; SQL 插入失败则移回暂存区. 取消时删除暂存文件. 文件与 SQL 分步执行, 不是文件系统事务.

Live2D, 立绘和参考音频各自最多一份主要资源. 删除主要参考音频时, Storage 事务选择下一份音频. 删除主要 Live2D 或立绘后不会自动选另一份. 封面单独保存, 不会进入导出的模型 ZIP.

## 舞台与通知

`inspectStagePresentation()` 返回 `blank`, `live2d`, `illustration` 或 `unavailable`. 已选择的资源缺失或无效时, 不会静默切换成另一种舞台类型.

Presentation 包含资源名与配置, 不包含本机绝对路径. Server 通过需要认证的接口提供立绘文件与 Live2D ZIP 流, ZIP 生成过程逐段读取模型文件.

Live2D 语义映射保存在 Profile 的 `character_live2d_models.emotion_map_json` 和 `motion_map_json`, 每个模型独立配置:

- `emotionMap` 把情绪映射到 `.model3.json` 登记的 Expression 名称.
- `motionMap` 把动作映射到已登记的动作组与数组下标.
- 只有已配置的语义词会进入 Prompt, 未配置的词不可用.
- 模型原生文件引用, 动作, 表情和参数组仍由模型文件定义.

模型目录和 ZIP 导入复制模型资源, 导出打包这些文件, 不附加数据库中的映射. 导入后在设置中配置映射. 内置艾玛的初始映射随角色种子写入数据库. 重新加载模型资源只重读原生文件, 不覆盖数据库映射.

立绘情绪名称来自 expression 分组. `buildCharacterPrompt()` 使用同一份 Presentation 生成可用标签说明. 人设正文不能包含舞台控制标签.

资源写入后, `onResourcesChanged()` 通知消费方重读资源. 只有舞台读取结果可能变化时才发送 `onPresentationChanged()`. 重做封面或导入非主要模型不会因此重载舞台.

Server 通过 `SessionRunningRegistry.runWithRegistrationsClosed()` 协调角色激活, 删除和部分主要资源修改. 它在暂停新注册的期间检查是否存在 Turn 或手动 Compact. 删除当前角色时, Server 选定替代角色再传给 Store. SQL 事务拒绝删除最后一个角色, 并把替代激活与角色删除一起提交.

## 表情包

Profile 的 `002_characterStickers.sql` 创建表情包表. 每张图片的 `name` 是带扩展名的文件名, 展示名与描述可以编辑. 导入后描述为空, 不进入 Prompt; 填写描述后, 程序生成名称, 描述和实际 Markdown 图片引用, 与人设和舞台说明一起进入角色 Prompt.

`@ema-agent/characters/stickers` 导出 `CHARACTER_STICKER_PROMPT_MAX_CHARS`, 值为 80,000. 限制计算的是完整表情包说明的 JavaScript 字符串长度, 包含说明文字和地址, 不表示 Token 数量. 保存超限时拒绝修改, 不截断已有条目. `Character.stickerPromptLength` 是读取时计算的展示值, 不另存数据库.

插图和表情包共用图片文件校验, 保留原图. 表情包没有主要资源或舞台映射. 删除后旧回复的图片地址可能失效, 聊天显示图片无法加载. 各资源 Store 与角色删除共用 `CharacterMutations` 的按角色队列, 防止导入途中角色目录被删除. 文件和 SQL 保存成功后才通知前端刷新.

## 阅读与测试

角色卡入口在 [store.ts](./store.ts), 资源业务分别在各资源目录的 `store.ts`. 图片校验位于 [imageFiles.ts](./resources/imageFiles.ts), Live2D 和音频仍使用各自的解析实现. [characterPrompt.ts](./characterPrompt.ts) 把 Presentation 转成提示词段落.

运行 `pnpm --filter @ema-agent/characters test` 和 `pnpm --filter @ema-agent/characters typecheck`. Store 测试使用临时目录和临时数据库, 覆盖身份, 删除, 暂存导入, 映射校验, 封面, 并发导入和启动清理. 不包含 WebGL 渲染和所有音频容器的验证.
