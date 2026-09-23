# @ema-agent/attachments

用户消息里的图片和长文本粘贴, 落盘并写入 SQL 账本, 发送时盖章
归属到 Turn, 超龄残留定期清扫. 另外提供图片的 Vision 文本描述缓存.

## 文件与账本

落盘与 `{dataDir}/sessions/{sessionId}/attachments/` 下:

```text
images/{uuid}.{ext}   图片(png/jpg/gif/webp)
pasted/{uuid}.txt     长文本粘贴(UTF-8, 0600 权限)
```

`path`(受管副本绝对路径)是全局主键。每个文件对应一条 SQL 账本行, 行生命周期:

```text
粘贴/拖入       写文件 + 写账本行(turn_id = NULL)
                粘贴那一刻 Turn 还不存在, 所以 turn_id 只能以后盖
发送时          claimForTurn 盖章, 行归属到本次发送的 Turn
Turn/Session 删除   SQL 外键级联删行
无行的文件      磁盘侧清扫按修改时间回收(写一半崩溃留下的残渣)
```

**claim 是重新绑定, 不是一次性盖章**: UPDATE 不带 `turn_id IS NULL` 条件。同一 path
可以先后盖到不同 Turn——Turn 崩溃或失败后, 续接队列会拿同一份已上传的输入重发,
第二次盖章必须成功, 否则消息永久发不出去。给这个 UPDATE 加 NULL 守卫会打断重试链。

## 公共入口

```ts
// 发送登记: Turn 准备(初始输入与立即引导)时调用
AttachmentStore
  attach(sessionId, turnId, blocks)
    // 图片/粘贴文本盖章; file_reference 走 realpath + stat 权威化
    // 返回的块就是写进消息 blocks_json 的最终形态(路径已替换为 canonical path)
    // 缺账本行、跨 Session 或已被删除 => 抛错, 整条消息不发送
  sweep(sessionId, olderThanMs)
    // 账本侧 + 磁盘侧双轨清扫, 两侧各自结算(一侧失败不连累另一侧)

// 图片
ImageStore
  saveImage(sessionId, bytes, originalName?)   // 服务器粘贴/上传端点调用; 规范化后落盘
  claimForTurn(sessionId, turnId, paths)
    // 返回没盖上的 path(未入账或不属于该 Session), 调用方据此硬失败
  readThumbnail(imagePath, maxDim = 256)       // 封面小图: 长边 ≤256 的 JPEG, 原图不动
  sweep(...)

// 长文本粘贴
PastedTextStore
  savePastedText(sessionId, content)
    // 少于 1000 字符直接拒绝——前端此时也不会调上传(见"粘贴文本"一节)
  claimForTurn / sweep 同图片

// Vision 描述缓存
VisionDescriptionCache
  getOrCreate(imagePath, signal, produce)      // 命中内存/SQL 直接返回; 否则调 produce 一次
  sweepIfIdle(options)                         // 空闲时按 TTL + 容量预算清扫
  clearCache()                                 // 只清内存, 不动 SQL
```

其他导出: `isLlmImagePath`/`mimeForPath`(投影判断用)、五个具名常量(见下)、
`attachmentCacheMaxBytesSetting` 与 `readAttachmentCacheSettings`、
`AttachmentPreparationError`(带 cause)、`AttachmentEvent`。

## 图片规范化

只收 `png / jpeg / gif / webp`, 其余格式拒绝。

| 上限 | 值 | 来源 |
|---|---|---|
| 字节数 | 3,932,160(3.75MB) | Anthropic 图片 5MB 上限按 base64 编码(膨胀 4/3)换算回原始字节: 5×1024×1024×3/4 |
| 边长 | 8000px | Anthropic 硬限 |

超限时: 先缩到 8000px 内; 字节数仍超且当前不是 jpeg, 再转 jpeg q85。
gif 只处理第一帧(sharp 默认行为)。不剥 EXIF/元数据——原图直发是当前接受项。

## 粘贴文本

- 超过 1000 字符才落成文件。低于阈值前端直接拼进输入, 不会走上传接口; 后端
  `savePastedText` 对低于阈值的输入直接拒绝——两侧契约一致。
- 预览定格 100 字符随消息块持久化, 让模型和 UI 判断值不值得整读, 组装零 IO。
- 直接写最终路径, 不先写临时文件再搬; 写一半崩溃留下的残渣由磁盘侧清扫回收。

## 清扫与回收

触发点: 打开 Session 历史路由时 fire-and-forget 跑一轮; 单个文件失败不阻断整轮。
所有清扫共用同一个 30 天年龄线(`ATTACHMENT_RESIDUE_MAX_AGE_MS`)——这是草稿保护窗:
贴了没发的附件 30 天内不删。

三种清扫, 各管各的:

1. **账本侧**(图片/粘贴文本各一轮): 删除 `turn_id IS NULL` 且超龄的行, 连带删文件。
2. **磁盘侧**: 目录里有文件、账本里没有行的(崩溃残渣), 按文件修改时间超龄即删。
3. **Vision 描述缓存**(sweepIfIdle): 最后访问超过 30 天的删除; 之后若总字节仍超过
   容量预算, 从最久未访问的开始删。每 6 小时最多跑一次, 且只在没有任何 Session
   在跑的时候执行。容量预算来自设置 `attachments.cache.maxBytes`(默认 64MB,
   可调 4MB–1GB), 每次清扫开始时现读——清扫中途改设置不影响这一轮。

## Vision 描述缓存

解决的是"模型不支持图片输入时, 把图转成一段文字"的重复劳动:

- 同一张图同时来多个请求, 只调一次 Vision, 其余请求等同一个结果(进程内存内去重)。
- 内存里最多留 256 条描述, 最近用过的留下, 满了丢最旧的(Map 的"删除再加"即刷新热度)。
- SQL 表以图片 path 为主键, 图片行删除时描述行跟着级联删除——描述绝不比图活得久。
- 描述可再生: 清扫删掉后, 下次用到时重新生成。
- 取消不是失败: abort 信号原样上抛终止 Turn, 不把"取消"降级成一段说明文本。

## 事件

`attachments_changed { sessionId }`: 保存附件成功、或清扫确实删了东西时发出,
经应用 SSE 广播; 消费方据此重查该 Session 的附件列表与统计。

## 消费方与依赖方向

- 装配: `apps/server` composition 构造 ImageStore/PastedTextStore/AttachmentStore
  (账本 repo 与事件出口在此注入)。
- 上传端点: `routes/sessions/attachments.ts` 直接调 saveImage/savePastedText。
- 发送链: Turn 准备(`src/turn`)经 `attach` 盖章; 桌面每次发送前经
  finalizeDraft 重新上传, 拿到新 path 再发送(所以正常路径不会重复盖章)。
- 展示与投影: 消息块只存 path; UserMessage 附件 chips、附件面板读两本账,
  `context/buildAttachmentMessages` 用 path 组装模型输入。
- 依赖方向: attachments → storage(repo 类型)、session(块类型)、settings;
  不依赖 server、desktop、turn。
