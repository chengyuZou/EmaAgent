# @ema-agent/attachments — Turn 附件（登记、受管副本、源状态、模型投影、Vision 描述缓存）

用户输入框附件的唯一业务所有者。冻结规格见 `docs/EmaAttachmentsBatch.md`（V2）。

## 业务边界

负责：一次 Turn 的附件输入定义；点击发送后的登记（realpath/stat 权威化）；图片原始字节
复制进 Session 受管目录；Message ⇄ 附件的稳定引用；用户原文件的状态检查；
`attachment_ref` 到模型内容的穷尽投影；模型无视觉能力时的 Vision 文本描述缓存。

不负责：Turn 生命周期、Context/Compact、LLM 协议转换、模型能力来源、Vision 连接与调用
（描述生产者由编排层注入）、KB ingest、文件能力句柄（V1 已删）、远程上传协议。

## 公共入口

```ts
// 登记与查询
AttachmentStore({ repo, dataDir })
  addAll(inputs, turnId, sessionId, limits?)   // 分类+限额+复制落盘+单事务；整批成功或整体失败
  listByTurn(turnId)
  getMany(ids)                                 // 投影前批量取件
  inspectBySession(sessionId)                  // 源文件四状态（available/modified/missing/inaccessible）

// 模型投影（TurnExecution 准备阶段调用；Context/Compact/LLM 不查本包）
resolveAttachmentReferences(blocks, attachments, { supportsImageInput, describeImage?, signal? })

// Vision 描述缓存（内存 + SQLite 双层，inFlight 同键去重）
VisionDescriptionCache(repo).getOrCreate(attachment, identity, signal, produce)
AttachmentCacheMaintenance({ repo, isIdle, maxBytesForSweep }).sweepIfIdle()

// 设置
attachmentInputSetting   // attachments.input（nextTurn；硬上限 10 图/5MiB）
attachmentCacheSetting   // attachments.cache（nextOperation；默认 64MiB 文本预算）
```

## 不变量

- 权威事实只认 Server 的 `realpath/stat`；wire 上的 name/mime/size/mtime 仅展示。
- 图片受管副本：`{dataDir}/sessions/{sessionId}/attachments/{attachmentId}{ext}`，
  原始字节直拷（不规范化）；随 Session 目录删除，孤儿由启动既有清扫兜底。
- Message 只存 `attachment_ref`；禁止 Base64/路径/名称副本进 `blocks_json`。
- 投影穷尽：找不到记录、副本读取失败、Vision 失败都产出模型可见文本，不用 filter 丢块。
- 文件与 SQLite 无法同事务：先发布副本 → 单事务写库 → 失败删本批副本。

## 明确不做

图片规范化（旋转/缩放/WebP/EXIF 剥离）、contentSha256 去重、像素上限、fileHandle 加密句柄、
音视频媒体处理。原图（含 EXIF/GPS）直发 Provider 是内测的已知接受项。
