# Character

Character 负责一张角色的人设 Prompt、Live2D、立绘和参考音频。它不负责 Turn 冻结、Prompt 总装配、Live2D 逐帧渲染、TTS 调用或前端表单。

## 领域对象

`CharacterStore` 是唯一业务入口。角色由以下内容组成：

- 可编辑的角色名称、描述与人设提示词 `personaPrompt`；
- 多个 Live2D、立绘和参考音频资源；
- 当前激活状态与内置只读标记。

角色及资源的随机 `id` 只用于 SQLite 关联，不进入磁盘路径。显示 `name` 可以修改，也不会移动资源。

## 磁盘结构

```text
~/.ema-agent/characters/<character.directoryName>/
├─ live2d/<live2dModel.directoryName>/
├─ illustration/<illustration.fileName>
└─ voice/<voiceSample.fileName>
```

`directoryName/fileName` 在导入时从 ZIP 或源文件名取得，创建后不可修改；同一目标已存在时直接拒绝，不覆盖也不自动追加后缀。

## 人设提示词

角色 Prompt 由人设提示词 `personaPrompt` 平铺，Live2D 控制协议在之后动态追加（由词汇表生成），不落入人设字段，也不能被用户编辑。

身份硬门由写入边界与装配边界共同守住：`create`/`update`/`activate` 都过 `assertPersonaPrompt()`（非空 + 禁止 `<emotion>`/`<motion>` 控制标签）；装配边界 `buildCharacterPrompt()` 只守空拒——拼起来为空就拒绝启动新 Turn。

人设字段禁止出现 `<emotion>` 和 `<motion>`，包括大小写变体与未闭合标签，避免占用系统控制协议。

## 资源导入与删除

Live2D 只接受 ZIP：

1. 从 ZIP 文件名派生稳定目录名；
2. 解压到最终目录，限制条目数、展开总字节和路径穿越；
3. 要求恰好一个 `*.model3.json`；
4. `runtime-config.json` 可缺失，缺失代表没有情绪/动作词汇；存在但损坏则拒绝；
5. 文件成功后插入 SQLite；SQL 失败只删除本次新建目录。

Live2D 导出会把当前展开目录打包成 `<显示名>.zip`。

立绘和参考音频保留用户原文件字节。立绘只检查大小与常见图片文件头，不归一化、不裁剪；参考音频检查格式、大小和时长。

删除顺序统一为“先文件、后 SQLite”。文件已经被用户手工删除时仍允许删除数据库记录；其他文件系统错误则保留记录并返回错误。

## 主用项与降级

每类资源最多一个启用的主用项。主用项被停用或删除后，存储层提升最早创建的启用资源。Live2D 主用切换会先读取新资源的可选运行配置，读取成功后才在同一 SQLite 事务中切换主用项并写入派生词汇，避免界面已经切换但模型仍拿旧词汇。

`inspectHealth()` 输出单个角色的实际可用顺序：

```text
有效 Live2D → 有效立绘 → 占位
```

Prompt 无效是 error；Live2D、立绘或参考音频缺失是 warning。健康检查不做哈希、版本兼容、深度修复或自动重绑定。

`inspectAllHealth()` 用于启动检查：除了逐个角色的健康结果，还会把角色根目录和三类资源目录第一层中“磁盘存在但 SQL 没有引用”的路径列为 `orphanedPaths`。它不猜测重命名关系，不自动删除或重绑定。

## 生命周期边界

- 新 Turn 在编排层冻结当时的 Character 与 Prompt 数组；运行中的 Turn 不随角色切换改变。
- Character 是全局激活对象。任意根 Turn 运行期间，应用层必须拒绝切换角色；前端在收到该 Turn 的 completed、failed 或 aborted 终态后再允许用户切换。CharacterStore 不监听 Turn，也不保存待切换意图。
- Turn 持久化冻结的 `character.directoryName`，不是可编辑的显示 `name`。该字段在 Turn/Memory 中分别命名为 `characterDirectoryName` 与 `character_directory_name`。
- `onSwitched` 和 `onPresentationChanged` 只发布领域变化；订阅者自行重新装配舞台、TTS 或 Prompt。
- 内置资源开发期可以由 `installBuiltinCharacterResources()` 从桌面静态目录复制；正式包只替换来源，运行时始终读取 Home 目录。
- 整张 Character 的归档导入导出暂不实现。当前 ZIP 仅用于单个 Live2D 资源。
