# @ema-agent/speech

Speech 接收根 Turn 的文字增量, 或已完成 Turn 的完整正文, 清理 Markdown、切句并按顺序调用 TTS. 所有 PCM 持续写入该 Turn 的同一份 WAV, 不在内存里保存另一份整轮音频. 文字 Turn 不等待语音生成、播放或文件保存.

本包负责生成、声音准备、文件写入与读取. Server 负责角色、模型绑定、SQL 记录和 HTTP / WebSocket. Desktop 独立决定播放顺序, 停止播放不取消后台生成.

## 生成入口

`SpeechCoordinator` 接收固定的 Session / Turn、Provider / 模型、声音、`CallTts`、`openAudio(format)` 闭包、取消信号和同步保存记录的回调. 闭包由 Server 绑定本次朗读角色和文件位置, Coordinator 不选择角色或查询角色资源. `acceptTextDelta()` 接收文字; `finish()` 等待剩余句子并完成保存; `cancel()` 中断生成. 完成与取消共用同一次完成 Promise, 不重复发布文件.

`savePartialAudio` 区分两种真实业务:

- 自动生成为 true. 某句供应商失败会通知警告并继续下一句; 取消时保留已经生成的部分.
- 手动整轮生成为 false. 所有句子成功才替换正式音频; 任一句失败、取消或保存失败都丢弃本次文件, 保留已有音频和记录.

文件写入失败或 PCM 采样率、声道改变时不能继续追加. `SentenceSplitter.feed()` / `flush()` 返回可朗读的字符串数组, 每句最多 200 个 UTF-16 code units, 不拆开代理对. 单句最多运行 120 秒并交付 16 MiB PCM.

每次真实 TTS 调用使用新的 UUID 记录 Usage, 重试或重新生成不复用 Turn / 句子索引. `quantity` 是清理后实际提交文本的 UTF-16 长度, `unit` 为 `character`; `durationMs` 是调用耗时, 不是音频播放时长.

### 手动生成已完成 Turn

`POST /api/turns/:turnId/speech` 接收 JSON `{ characterName?: string }`, 不接收前端指定的正文或音频路径. Server 从已完成 Turn 读取正常 Assistant 消息里的 text 块, 不朗读 thinking、工具调用或用户消息.

省略 `characterName` 时使用当前激活角色, Settings 可以明确选择其他角色, 不改变激活角色. TTS 模型使用当前绑定. 角色已不存在、没有参考音频、没有选用主参考音频或文件已丢失时返回具体原因. Turn 的 `characterName` 仍表示当时参与对话的角色, 不决定后来的朗读声音. 未完成 Turn 返回 409, 同轮已有生成任务时也返回 409; 配置问题返回 422.

响应带 `sessionId`、`turnId` 和最终状态:

- `completed`: `audioAvailable=true`, 文件和 SQL 已保存.
- `cancelled`: `audioAvailable` 表示取消后是否仍有原来的正式音频.
- `failed`: 带 `code`、`message` 和原有音频是否可用, 不把失败当成生成完成.

`POST /api/turns/:turnId/speech/cancel` 只取消该轮语音, 等任务退出后返回 204. 手动生成不绑定请求连接的取消信号, 切换页面或断开 HTTP 不自动取消生成. 生成完成只刷新音频事实和通知用户, 不自动播放.

## 文件与正式记录

`FsAudioArchive.openTurn(sessionId, turnId, characterName, format)` 返回 `AudioWriter`. 路径为 `sessions/<sessionId>/audio/<turnId>/<turnId>-<characterName>.wav`, 角色名使用稳定的 `Character.name`. 同一轮可保留多个角色版本, 重新生成只替换同一路径. 调用方必须等待 `write(bytes)` 完成后再取下一块; 磁盘来不及写时暂停读取 TTS 的后续结果.

`finish(saveRecord)` 补齐 WAV 头、发布正式文件, 然后同步调用 `saveRecord`. 回调必须在返回前完成这一次 SQL 写入; 抛错时恢复之前的正式文件, 或移除第一次生成的文件. 重新生成替换前保留一份临时旧文件, 正式记录写入成功后释放它. `discard()` 删除本次 pending, 不修改原来的正式音频.

```text
文字 -> 清理和切句 -> CallTts -> PCM 块
                                  |
                                  v
 sessions/<sessionId>/audio/<turnId>/<turnId>-<characterName>.wav.pending
                                  |
            完成保存: 补齐 WAV 头, 发布正式 WAV
                                  |
                       同步写 speech_outputs
                                  |
                  成功后 session_audio_changed
                                  |
                  speech_generate_* 终态通知
```

没有 PCM 时删除空文件并返回 null. 保存成功的 `FinalizedAudio` 带路径、`audio/wav`、字节数和毫秒时长. SQL 只记录正式 WAV, 不记录 pending; Backup 也只处理正式记录, 包括自动生成取消后保留的部分. 不使用 `segment_count`.

第一块 PCM 写入成功后只调用一次 `onAudioReady`, 此时初次自动生成的文件已能读取. 生成期间 WAV 头使用未知长度, 保存时更新真实长度和时长.

## 音频读取与生成通知

`FsAudioArchive.openRead(sessionId, turnId, characterName, signal)` 先读取该角色已有的正式文件. 因此重新生成期间的“播放音频”仍播放旧音频, 不播放尚未完成的替代文件. 没有正式文件时可以读取该角色正在写入的初次生成文件.

生成中 `byteSize=null`, 正式文件返回真实大小. 每个读取方持有自己的文件位置, 每次最多取 64 KiB. 读到当前末尾等待后续写入, 不把句间停顿当成结束; 文件完成并读完 PCM 后结束响应. 关闭读取流只关闭当前读取方, 不取消生成.

`GET /api/turns/:turnId/audio` 先通过 Turn 查 Session, 只读取当前激活角色的版本, 不接收任意本机路径. 原生 audio 不能设置认证请求头, 所以指定音频 GET 与 WebSocket 通过 `secret` 查询参数携带现有进程口令; 其他 HTTP 仍用 `X-Ema-Secret`. 响应禁止缓存, 生成中的响应不发送 Content-Length.

`GET /api/sessions/:sessionId/audio` 返回 Turn 摘要, 包括没有音频的轮次; `GET /api/turns/:turnId/audio-records` 返回这一轮的角色音频、当前角色的生成资格和已选用主参考音频的角色选项. 前端打开菜单或展开记录时查询, 角色切换、资源变更和音频保存后重新读取.

`SpeechGenerateEvent` 带 `sessionId` 和 `turnId`, 不带文件路径、URL 或音频块. WebSocket 交付生成开始、单句警告和生成终态, 也接受明确的生成取消命令. 终态里的 `audioAvailable` 不表示浏览器已经播完. 断开连接仅结束订阅, 后端仍生成并保存.

Desktop 的 `turnSpeechGeneration.ts` 为自动生成 Turn 独立订阅状态. 没有取得播放资格的 Session 也会显示生成状态与取消入口. 手动生成请求由该共享模块持有, Footer 卸载不会取消它; 最终结果只刷新该轮消息和音频状态.

## Desktop 播放队列

`sessionPresentation` 的队列是有序的 `{ sessionId, turnId }[]`. 首项驱动桌宠与当前播放器, 后续项只保存同 Session 的待播身份, 不预下载整轮音频.

- 新 Turn 只在开始时申请一次. 队列空时立即成为首项; 同 Session 加到末尾; 其他 Session 在入口拒绝, 不进入队列, 后台生成继续.
- `speech_generate_completed` 不交接播放. 当前 audio 实际触发 `ended` 后才取下一项, 更新 src 并播放.
- 先前被拒绝的 Turn 不在空闲后补播. 以后新启动的 Turn 可以重新申请.
- TTS 关闭时, 纯文字 Turn 仍可申请空闲首项驱动桌宠文字、情绪和动作, 正文结束后释放.

`startTurnSpeechPlayback()` 只负责入队和播放, 不拥有生成订阅. `replayTurn()` 主动替换当前播放及全部待播项, 不取消那些 Turn 的生成. `stopTurnPlayback()` / `stopSessionPlayback()` 清空本地播放队列并释放播放器, 不发送生成取消. 根 Turn 失败或取消只移除对应项.

普通 Session 切换不改变播放. Server 完成 Session 归档或删除的任务取消后, 前端清理该 Session 的播放器、生成观察和待播项, 迟到结果不能恢复它.

原生 audio 收到 `turnsApi.audioUrl()` 后边读取边解码, 不先下载完整 Blob 或 `decodeAudioData` 整轮文件. 设置 CORS 后再赋 src, 音源只接一次输出. wLipSync 使用独立 Worklet / WASM; 加载失败时播放继续, 改用音量变化驱动口型.

释放播放器时先撤销媒体监听, 暂停 audio、清空 src、断开音源并停止口型. 迟到的 URL、Worklet 与 `play()` 回调都核对播放器身份, 不能恢复旧音源或清掉下一轮.

### 操作入口

Turn Footer 使用共享 `DropdownMenu`, 始终显示“播放音频”和“生成音频 / 重新生成音频”. 两项只针对当前激活角色, 不可用时显示具体原因. 已保存音频不因删除参考声音而消失, 仍可播放; 生成需要现有主参考音频和已完成正文. 正在播放时显示停止播放, 生成中另外提供取消生成. 重新生成只从待播列表移除目标 Turn, 不停止其他播放.

Settings 按 Turn 列摘要, 展开一轮才读取各角色记录, 每个版本使用全宽的普通文件播放器. “重新生成音频”菜单列出有主参考音频的角色, 明确选择后保存, 不自动播放. 普通文件播放器不进入 Chat 播放队列, 不驱动 Live2D 口型.

侧栏的 `SessionAudioButton` 只显示当前播放 Session, 放在标题左边, 不占右侧菜单的位置. 悬停或键盘聚焦显示实心停止图标, 点击不触发行选择. 状态圆点仍保留. 最近活动时间放在标题的悬浮详情卡中, 不与菜单按钮共用行内位置.

聊天消息区底部的喇叭只定位当前播放 Turn, 不改变播放. 点击时固定目标; 未加载该轮索引时查询该轮消息, 再打开有界历史窗口. 同时显示回到最新按钮时, 两个按钮围绕聊天区中线对称排列; 只有一个时居中. 两个按钮共用淡入、上移动画, 位置变化也平滑移动. 定位后的 Turn 短暂高亮 1.8 秒, 不改变行高; 减少动画时不播放过渡. 导航轨另外标出当前播放 Turn.

## 参考声音与试听

`SpeechVoiceCache.prepare()` 只缓存当前 Node 进程内的 Provider 声音标识, 不写 SQLite. 缓存键包含角色、完整资源名与更新时间、Provider 和模型.

`SpeechVoicePreview` 复用声音准备和 TTS 协议入口, 收集最多 16 MiB PCM 后包装完整 WAV 头, 返回 `audio/wav`. 不重新采样、不启动转换进程或创建临时文件, 试听不进入 Session Storage 或 Backup. TTS 协议属于 `@ema-agent/tts`, 转写属于 `@ema-agent/stt`.

## 验证与限制

`pnpm --filter @ema-agent/speech test` 验证 WAV 读写、多角色保存、取消、替换失败恢复与逐次用量记录. Server 的 `turnSpeechGeneration.test.ts` 使用真实 HTTP 与临时 SQLite 验证当前角色、明确选角、正文读取、重复调用、取消和保存失败; `turnSpeechWebSocket.test.ts` 验证生成通知、读取和多角色备份.

Desktop 的 `turnAudioControls.test.tsx` 验证真实菜单、角色切换、资源刷新和逐角色播放器. `tests/turnAudio.html` 使用真实组件与固定数据检查菜单、播放器宽度和窄屏布局, 不访问用户数据库或模型.

上述测试不代替真实供应商、Tauri WebView 播放和口型验收. 当前没有整轮待合成文字上限, DashScope 回调队列也没有独立容量限制; 普通 WAV 长度字段有限制. 大文件 Range / 定位、几十分钟生成与浏览器缓冲表现仍需单独验收.

