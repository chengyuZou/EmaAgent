# Speech

[English](./README.md)

Speech 把助手可见正文变成按顺序执行的 TTS 请求, 为每个 Turn 和朗读角色写一份 WAV. 自动生成接收增量, 手动生成输入已完成正文. 后台生成与桌面播放各自运行.

Turn 不等待语音合成或播放完成才结束. 播放归属和多角色音频的取舍见[语音设计](../../docs/design/speech/README-zh.md).

## 生成

Server 创建 `SpeechCoordinator` 时提供固定 Session/Turn, Provider/模型, 已准备声音, `CallTTS`, `openAudio(format)`, 取消信号和同步保存回调. 用 `acceptTextDelta` 输入文字, 最后等待 `finish`. `cancel` 中止生成并共用同一次完成 Promise.

`TextFilterStream` 跨增量保存代码和数学围栏状态, 改为朗读短标签. `SentenceSplitter` 避开缩写和小数点, 合并过短片段, 每段最多 200 个 UTF-16 码元且不拆代理对. `filterSentenceForTTS` 再清理行内 Markdown, URL 和路径.

句子串行处理, 每句最多运行 120 秒并交付 16 MiB PCM. 每次真实 TTS 请求有独立用量 ID. 数量为实际提交文本的 UTF-16 长度, 耗时是请求时间而非播放时长.

- 自动生成传 `savePartialAudio: true`: 单句 Provider 失败后警告并继续, 取消时保留已完成 PCM.
- 手动生成传 `false`: 失败或取消时丢弃本次结果, 保留已有音频.
- 文件写入失败或 PCM 格式改变会停止追加. 自动模式仍可保存此前已完成 PCM.

## 文件, 记录与读取

`FsAudioArchive` 接收当前数据目录下的 `audio/` 根目录. 调用方必须保证同一 Session/Turn/角色的写入串行.

```text
CallTTS PCM
  -> await AudioWriter.write
  -> audio/<sessionId>/<turnId>/<turnId>-<characterName>.wav.pending
  -> 补齐 WAV 头并发布文件
  -> 同步 saveRecord
  -> Server 发送 session_audio_changed, 再发送生成终态
```

文件名使用稳定 Character.name, 名字可以含连字符. `finish(saveRecord)` 发布 WAV 后同步写记录, 回调失败时恢复旧文件或移除首次发布文件. `discard` 只删除本次 pending. 没有 PCM 时不生成正式文件, 返回 null.

每块 `write` 完成后才取下一块 TTS. 各读取方持有独立位置, 每次最多读取 64 KiB. 初次生成读到当前末尾时等待更多 PCM, 完成后才结束流. 关闭读取方不取消生成. 替换已有音频期间继续读取旧正式文件.

第一块 PCM 写成功后调用 `onAudioReady`. 生成中 `byteSize` 未知, HTTP 不能发送 Content-Length. 正式记录包含真实字节数与毫秒时长. 正常完成或丢弃不等同于异常退出后的恢复处理.

## 声音准备与试听

`SpeechVoiceCache.prepare` 在当前 Node 进程缓存 Provider 声音 ID, 键包含角色, 资源名/版本, Provider 和模型. 本地参考声音仍调用 registrar, 不缓存. 并发准备不会合并成一个请求.

`SpeechVoicePreview` 准备当前参考声音, 最多收集 16 MiB PCM 后在内存打包完整 WAV, 不创建 Session 音频文件. `SpeechVoicePreviewTTS` 提供配套的注册与合成入口.

## 宿主接入与检查

[Server speech composition](../../apps/server/src/composition/speech.ts) 选择角色和模型, 保存 `speech_outputs`, 串行管理每个 Turn 的生成, 发送 `SpeechGenerateEvent` 和 `SpeechArchiveEvent`. 事件表示生成状态, 不表示已经播完. 桌面端管理 audio, 播放队列和口型, 停止播放本身不会取消后台生成.

先看 [speechCoordinator.ts](./speechCoordinator.ts), 再看 [audioArchive.ts](./audioArchive.ts). `tests/audioArchive.test.ts` 使用真实临时 WAV 和 SQLite 用量记录检查读取, 取消, 替换和保存失败恢复. 其他测试检查文本过滤与声音缓存.

```sh
pnpm --filter @ema-agent/speech test
```

测试不代替真实 Provider 和 WebView 播放检查. 当前没有整轮排队文本上限. 过滤器是启发式处理, 例如未闭合数学块结束时仍输出代码标签, 纯文本快速路径保留数字列表前缀. 长录音, 普通 WAV 大小限制, 浏览器缓冲和定位需要另行实测.
