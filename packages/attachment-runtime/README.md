# @ema-agent/attachment-runtime

## 一句话职责

附件上传、解析、分块、索引与召回。附件是独立资源，通过 attachmentId 与会话关联。

## 上游依赖（我可以 import 谁）

- `@ema-agent/core-types` —— AttachmentMeta、RecallChunk
- `@ema-agent/constants-core` —— 附件相关常量

## 下游消费者（谁可以 import 我）

- `@ema-agent/orchestrator-runtime` —— 附件召回注入上下文
- `@ema-agent/api-gateway` —— 附件上传/下载接口
- `@ma-agent/memory-runtime` —— 附件索引结果纳入统一召回

## 对外接口

- `export interface AttachmentService` —— 附件服务接口
- `export function parseDocument()` —— 文档解析
- `export function indexAttachment()` —— 附件索引
- `export function recallAttachmentChunks()` —— 附件片段召回

## 禁止事项

- ❌ 禁止 import `session-runtime`（不应直接操作会话）
- ❌ 禁止 import `orchestrator-runtime`（防止循环）
- ❌ 禁止在附件里存储会话级状态
- ❌ 禁止在解析逻辑里硬编码文件格式限制（应走配置）
