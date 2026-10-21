# Attachments

[English](README.md)

`@ema-agent/attachments` 保存图片副本和长文本粘贴, 将记录绑定到 Turn, 清理过期未使用文件, 并缓存聊天模型不能直接接收的图片描述.

## 保存和发送

Server 将 Storage Repo, 当前数据目录和可选事件函数传给 `ImageStore` 与 `PastedTextStore`, 再将两者交给 `AttachmentStore`.

| 输入 | 保存方式 | 发送时 |
| --- | --- | --- |
| PNG, JPEG, GIF, WebP | 当前数据目录下的 `attachments/<sessionId>/images/<uuid>.<ext>` 和图片记录. | 将路径绑定到当前 Turn. |
| 长度 >=1000 的粘贴文本 | `attachments/<sessionId>/pasted/` 下的 UTF-8 文件和文本记录. | 绑定路径, 保留保存时的预览. |
| 普通文件 | 原本的本地路径. | 解析实际路径, 检查是普通文件. |

```ts
const saved = await imageStore.saveImage(sessionId, bytes, originalName);
const blocks = await attachments.attach(sessionId, turnId, [
  { type: 'image_reference', path: saved.path },
]);
```

桌面先将新图片和粘贴文本保留在草稿, 由 [submitChatDraft](../../apps/desktop/src/chat/input/submitChatDraft.ts) 在发送前上传. [附件路由](../../apps/server/src/routes/sessions/attachments.ts) 调用保存函数. `attach` 绑定图片/文本记录, 返回要写入消息的附件块. 缺少记录或不属于该 Session 时拒绝发送. 允许替换旧 Turn 绑定, 使失败输入可以复用已上传文件. 图片绑定, 文本绑定和普通文件检查是独立操作, 不处于同一个回滚事务.

`file_reference` 保留原位置, 文件移动或删除后可能无法读取. [Context](../context/buildAttachmentMessages.ts) 为支持图片的模型读取图片字节, 否则使用 Vision 描述. 普通文件和粘贴文本转换为路径/预览文字, 供模型按需读取.

## 图片和文本

图片解码后检查格式, 只有处理图片或缩略图时才加载 sharp. 不超过 3,932,160 字节且每边不超过 8000 像素时原样保存. 超过阈值时缩放, 非 JPEG 输出仍过大时转为质量 85 的 JPEG. 当前只做这一轮转换, 不保证最终字节数一定低于阈值. 转换动图只使用第一帧, 未转换文件保留原字节. `readThumbnail` 默认生成长边不超过 256 像素的 JPEG, 不修改原图.

文本阈值和预览按 JavaScript 字符串长度计算, 单位是 UTF-16 码元. `savePastedText` 接受长度 >= `PASTE_TEXT_MIN_CHARS` 的正文, 返回前 `PASTE_TEXT_PREVIEW_CHARS` 个码元, 当前为 100. 文件保存完整原文.

## Vision 缓存和清理

`get(path)` 只读已有描述. `getOrCreate(path, signal, produce)` 依次检查内存, SQL, 再生成描述. 键是图片路径, 更换 Vision 模型不会使旧描述失效. 内存默认最多 256 条.

同一路径的并发生成共用一个 Promise 和首次调用的 signal, 后加入者不能独立取消等待. 缓存命中直接返回, 不执行生成路径的取消检查. 新生成在 produce 前后检查取消, 去除结果首尾空白, 拒绝空描述.

`sweepIfIdle` 检查空闲条件及六小时最小间隔. 先删 SQL 中超过 30 天未访问的描述, 再按最久未访问顺序删到容量预算内. 默认 64 MiB, 可设为 4 MiB 到 1 GiB. 这不会清除内存条目, `clearCache()` 才清内存, 且不删除 SQL.

`AttachmentStore.sweep` 分别运行图片和文本清理, 保留两侧的成功或失败结果. 各自删除超龄未绑定记录及文件, 再删除无记录的超龄文件, 默认年龄为 30 天. 删除已登记文件失败时仍移除其记录, 因此 deletedFiles 和 freedBytes 是清理记录的统计, 不是实际磁盘释放量.

保存成功和删除超龄未绑定记录时发 `attachments_changed`, Server 用它刷新附件视图. Vision 描述维护不发这个事件.

## 验证

[attachmentStore.ts](attachmentStore.ts) 处理发送准备, [imageStore.ts](imageStore.ts) 和 [pasteStore.ts](pasteStore.ts) 处理文件保存, [visionCache.ts](visionCache.ts) 处理描述复用.

```sh
pnpm --filter @ema-agent/attachments test
pnpm --filter @ema-agent/attachments typecheck
```

测试使用临时目录和 SQLite, 检查文件, 记录, 图片转换, 绑定, 缓存和清理.
