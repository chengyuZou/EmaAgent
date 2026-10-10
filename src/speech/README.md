# @ema-agent/speech

Speech 旁路接收根 Turn 的文字增量, 清理 Markdown 并切句后按顺序调用 TTS. 每个 Turn 的所有 PCM 块持续写入同一份 WAV, 不保存另一份整轮音频到内存. 文字 Turn 不等待语音生成、播放或文件保存.

设置页通过 `SpeechVoicePreview` 试听. 实时对话和历史重播由 Desktop 的原生 audio 读取 Turn 音频 URL, 本包只负责生成、文件写入和读取, 不决定哪个 Turn 播放.

## 生成与文件

`SpeechCoordinator` 接收 `sessionId`、`turnId`、固定的 Provider/模型、准备好的声音、`CallTts`、`FsAudioArchive` 和取消信号. `acceptTextDelta()` 接收文字; `finish()` 等待所有句子并完成文件; `cancel()` 中断合成, 保存已经写入的部分. 后两个入口共用一次完成 Promise, 不重复发布文件.

`SentenceSplitter` 每句最多 200 个 UTF-16 code units, 无空白长文本也会切分, 不拆开代理对. 单句合成最多运行 120 秒并交付 16 MiB PCM. 每句单独记录字符数与调用结果到 Usage. 普通供应商单句失败会通知 `onSentenceError` 并继续后面的句子; 文件写入失败或采样率/声道改变则停止追加, 不能把不同格式的 PCM 塞进同一份 WAV.

`FsAudioArchive.openTurn(sessionId, turnId, format)` 创建一个 `AudioWriter`. 调用方必须等 `write(bytes)` 完成后再取下一块, 所以磁盘来不及写时, Speech 会暂停读取这次 TTS 的结果. `finish()` 返回文件路径、`audio/wav`、字节数和毫秒时长; 没有 PCM 时删除空文件并返回 null.

```text
Turn 文字增量 -> 清理和切句 -> CallTts -> PCM 块
                                          |
                                          v
                    sessions/<sessionId>/audio/<turnId>.wav.pending
                                          |
                           完成或取消: 补齐 WAV 头并改名
                                          v
                    sessions/<sessionId>/audio/<turnId>.wav
                                          |
                           Server 保存 speech_outputs 记录
                                          |
                           session_audio_changed 通知
                                          |
                           speech_generate_* 终态通知
```

第一块 PCM 写入成功后只调用一次 `onAudioReady`, 此时 Server 可以发 `speech_generate_started`. 生成期间文件头使用未知长度; 完成或取消后写真实长度, 计算时长并发布正式 WAV. 取消后的正式文件可以少于整轮文字, 但仍是结构完整的 WAV. 文件改名或头部更新失败时不登记音频; 已经保存成功但 SQL 登记失败的文件仍可通过 Turn 路由读取.

## 读取与通知

`FsAudioArchive.openRead(sessionId, turnId, signal)` 返回 `AudioRead` 或 null. 正在生成时 `byteSize=null`, 已完成时返回真实大小. 每个读取方持有自己的文件位置, 一次最多取 64 KiB. 读到当前末尾会等下一次写入, 不把句间停顿当成结束; 文件完成且已读取全部 PCM 后结束响应. 关闭读取流或取消读取信号只关闭这个读取方, 不取消合成.

Server 使用既有 `GET /api/turns/:turnId/audio` 提供实时和历史文件流. 路由先从 Turn 查询 Session, 不接受任意本机路径. 原生 audio 不能设置 `X-Ema-Secret`, 所以只有音频 GET 与 WebSocket 允许通过 `secret` 查询参数携带现有进程口令; 其他 HTTP API 仍用请求头认证. 音频响应禁止缓存, 生成中的响应不发送 Content-Length.

`SpeechGenerateEvent` 均带 `sessionId` 和 `turnId`, 不带文件路径、URL 或二进制音频. WebSocket 只交付生成开始、单句警告、生成完成/取消/失败、不可用状态, 并接收 `speech_generate_cancel`. 生成终态带 `audioAvailable`, 与浏览器是否播放结束无关. 断开 WebSocket 只结束订阅; 重新连接时, 正在写入的文件可通知开始, 正式文件可通知生成完成.

文件完成并写入 `speech_outputs` 后, Server 才发送 `SpeechArchiveEvent` 中的 `session_audio_changed`. SQL 只记录正式 WAV, 不记录 pending 文件. Backup 同样只处理有正式记录的文件, 包括取消后保留的部分.

## Desktop 播放

`turnsApi.audioUrl(turnId)` 使用当前 Server 地址和进程口令组装音频地址. `startTurnSpeechPlayback(sessionId, turnId)` 只为取得 owner 的新 Turn 打开生成状态 WebSocket. 收到 `speech_generate_started` 后, 把 URL 交给原生 audio; 收到生成完成后不截断仍在播放的媒体. `replayTurn(sessionId, turnId)` 使用相同 URL, 不订阅生成事件. 两条路径都不先下载完整 Blob, 也不调用 `decodeAudioData` 解码整轮文件.

```text
第一块 PCM 已写入 -> speech_generate_started -> Desktop 设置 audio.src
                                                       |
                                                       v
                 GET /api/turns/:turnId/audio -> 分段读取文件 -> 浏览器缓冲、解码、播放
```

播放器先设置 `crossOrigin=anonymous`, 再设置 URL. Server 的 CORS 响应允许本机 WebView 源, 因此 `createMediaElementSource` 能把当前媒体的采样接到同一份 AudioContext. 这个音源只接一次输出, 口型分析不额外出声, 也不另读整轮文件.

口型使用 wLipSync 包内的独立 Worklet 脚本和 WASM 文件. Vite 输出正式资源地址, 不把 Worklet 内联成 data URL; 桌面 CSP 仅额外允许 `wasm-unsafe-eval` 编译 WASM, 不允许 JavaScript 的 `unsafe-eval`. 加载失败时, 播放继续并改用音量变化驱动口型.

Footer 在等待音频或读取 URL 时也提供停止按钮. 本地停止先取消媒体事件监听, 暂停 audio 并清除 src, 断开当前音源, 停止口型和释放 owner; 不等网络通知返回才释放. 异步取得 URL、Worklet 和 `play()` 的回调都核对当前播放器身份, 不能接回已经停止的音源或清掉下一轮.

## 停止与播放归属

开启 TTS 的 Turn 不依赖播放器连接或 owner 才能合成, 也不等待播放进度确认. 当前没有三句或 10 秒的生成限制. 播放 owner 由 Desktop 决定, 不影响后端合成.

TTS 开关在 Turn 开始时决定这一轮是否生成音频. 中途切换开关只影响后续 Turn, 不停止当前生成或播放. Footer 的 `stopTurnPlayback(sessionId, turnId)` 才会停止当前发音, 并在实时生成尚未结束时发送 `speech_generate_cancel`; 已经生成的部分保存为正式 WAV, 文字继续生成.

Desktop 同时只允许一个 owner 驱动桌宠的文字、情绪、动作和口型. 新 Turn 开始时只申请一次: 已有 owner 就不播放, 不保存待播队列. 媒体自然结束、停止或失败都立即释放 owner, 不等待正文结束; 释放后不自动接播已经开始的其他 Turn. 没有本地语音的 owner 随正文结束释放. 用户主动历史重播也只申请空闲 owner, 不抢占正在呈现的 Turn.

普通 Session 切换不改变已有 owner. Session 归档或删除成功后, 前端停止属于该 Session 的本地媒体. 生成状态连接意外断开时, 前端停止当前播放并释放 owner, 不把断线当作生成取消; 后端仍独立完成保存.

根 Turn 失败/取消时停止语音. 根 Turn 文字正常完成时, 语音可以继续处理剩余句子. Server 登记声音准备中的任务, 所以 Session 删除、归档和 Server 关闭会取消并等待相关任务完成; 删除数据行或关闭数据库发生在语音保存之后. 只取消语音不会取消文字 Turn, TTS 开关变化也不自动停止当前语音.

没有整轮文字队列上限, 普通 WAV 长度字段也有限制. DashScope 回调队列当前没有独立容量限制. 大文件 Range/定位、几十分钟生成与浏览器播放的内存表现仍需单独验收, 不能据此声称整条链拥有固定内存上限.

## 参考声音与试听

`SpeechVoiceCache.prepare()` 只缓存当前 Node 进程内的 Provider 声音标识, 不写 SQLite. 缓存键包含角色、完整资源名与更新时间、Provider 和模型. Server 决定角色、TTS binding 与协议入口, 本包不读取角色或 Provider Repo.

`SpeechVoicePreview` 复用相同的声音准备与协议入口, 收集最多 16 MiB PCM 后用 `packPcmWav` 添加完整 WAV 头, 返回 `audio/wav`. 保留实际采样率和声道数, 不重新采样, 不启动转换进程或创建临时文件. 试听结果不进入 Session Storage 或 Backup.

协议请求和音色注册属于 `@ema-agent/tts`; 转写属于 `@ema-agent/stt`; Session 和 Turn 的文字终态仍由对应业务包管理.

测试入口: `pnpm --filter @ema-agent/speech test`. Server 的 `turnSpeechWebSocket.test.ts` 另外使用真实本机 HTTP/WebSocket、临时 SQLite 和 ZIP 验证传输与备份. Desktop 的 `src/chat/speech/tests/turnSpeechPlayback.test.ts` 验证 URL 入口、owner、停止、断线与迟到回调. 这些测试不代替真实供应商、WebView 播放和口型验收.
