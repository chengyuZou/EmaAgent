# Character

Character 管理全局当前角色、Persona、角色舞台选择和三类本地角色资源。它不管理 Turn、普通后台进程、Memory 内容或 Narrative 进程；跨域停止顺序由 Server 应用层编排。

## 身份

```ts
interface Character {
  name: string;
  displayName: string | null;
  description: string | null;
  personaPrompt: string;
  stageKind: 'live2d' | 'illustration' | 'blank';
  isActive: boolean;
  lastActivatedAt: number | null;
}
```

`name` 是用户创建时给定且创建后不可修改的稳定身份，同时是 SQL 主键、角色目录名和未来 Relationship Memory 目录身份。`displayName` 只负责显示，可以修改；为空时 UI 显示 `name`。

全局只能有一个当前角色。新角色默认 `stageKind='blank'` 且不自动激活。最后一个角色不能删除；删除当前角色后激活最近使用的其他角色。艾玛只是种子角色，没有只读或删除保护。

## 资源

```text
~/.ema-agent/characters/<characterName>/
├─ live2d/<live2dName>/
├─ illustration/<illustrationName>
└─ voice/<voiceName>
```

- `live2dName` 是导入 ZIP 去扩展名后的名称，或导入文件夹名称。
- `illustrationName` 是完整图片文件名。
- `voiceName` 是完整音频文件名。
- 每份资源另有可编辑 `displayName`，修改它不移动文件。
- 三类资源均无 `enabled`。每类至多一份 `isPrimary`；删除主要资源不自动提升其他资源。
- Live2D 支持 ZIP 或文件夹导入。
- Voice 只支持本地文件路径导入，参考文本和语言导入后不可修改；最大 512 MiB、最长 1 分钟。
- Illustration 可带一个 `expression`。同一表情最多 10 张，表情池由查询结果派生，不另存 JSON。

## 舞台

`inspectStagePresentation(characterName)` 只返回用户明确选择的一种结果：

- `blank`：角色生效，但舞台不显示资源。
- `live2d`：返回主要 Live2D。
- `illustration`：返回默认立绘及按 `expression` 分组的候选池。
- `unavailable`：已选择的类型缺主要资源、文件丢失或资源损坏。

不存在 Live2D → 立绘 → 空白降级链。损坏时由前端显示错误并让舞台为空白。应用只有主窗口的一份舞台 Canvas。

Stage 对每个合法 `<emotion>` 都发出 `emotion_changed`，即使前后值相同。立绘消费者收到事件后从对应表情池随机选择；池内多于一张时排除当前图片，再用普通交叉淡入淡出换图。立绘没有呼吸动画。

Character 和 Live2D 资源行都不保存情绪或动作词汇。Live2D 词汇只取当前 Presentation 中 `runtime-config.json` 的 `emotionMap`、`motionMap` 键；立绘情绪词只取 Presentation 的 `expression` 分组。Turn Prompt、StageEngine 和主窗口都消费 CharacterStore 产出的 Presentation，不各自维护词汇副本。

用户手改 `runtime-config.json` 后调用 `reloadLive2dConfiguration`。该操作校验并返回当前完整配置，再广播舞台变化；不写 SQL 词汇列。

## Server 协调

激活另一个角色或删除当前角色时：

1. 若存在根 Turn、手动 Compact 或普通后台进程，未带确认的请求返回 `409 character_work_running`。
2. 用户确认后，请求带 `terminateRunningWork: true`。
3. Server 并行中止全部根 Turn/Compact 和普通后台进程，并等待退出。
4. Memory 提取、整合和维护 Job 不停止。
5. 再激活目标角色，或删除当前角色并激活最近使用的剩余角色。

当前角色有根 Turn 或手动 Compact 运行时，Persona、`stageKind`、主资源和资源内容修改返回同一冲突；非当前角色可以编辑。普通后台进程只阻止全局切换/删除，不阻止资源编辑。

## HTTP 名称

角色路径参数统一叫 `characterName`，资源路径参数分别叫 `live2dName`、`illustrationName`、`voiceName`。调用方必须对这些路径段使用 `encodeURIComponent`。

公开 Character API 不提供 Duplicate，不提供 Voice multipart publish，也不提供资源 `enabled`。未来若实现 Duplicate，必须先明确资源和外部关系的完整复制语义。
