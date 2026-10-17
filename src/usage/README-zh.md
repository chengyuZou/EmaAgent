# Usage

[English](README.md)

Usage 将每次模型 API 请求的实际用量保存到当前数据数据库. LLM, Vision, Embed, Rerank, TTS 和 STT 的调用方在请求完成, 失败或取消后提供完整的 `UsageRecord`.

## 保存与查询

```ts
import { UsageRecorder } from '@ema-agent/usage';

const usage = new UsageRecorder(dataDb);
usage.record(record);
const page = usage.list({ sessionId, capability: 'llm', limit: 50 });
const nextPage = page.nextCursor
  ? usage.list({ sessionId, capability: 'llm', limit: 50, cursor: page.nextCursor })
  : null;
const turnRecords = usage.forTurn(turnId);
```

调用方提供每次实际请求的唯一 ID, Provider, 模型, 可为空的 Session 和 Turn ID, 终态及已取得的用量. 后台请求可以没有 Session 和 Turn. `createdAt` 使用请求开始时的 Unix 毫秒时间, 虽然记录在请求结束后才写入.

`record` 将业务字段转换为 SQL 列, 通过 Storage 的 `UsageRecordsRepo` 插入. ID 重复或其他写入错误只输出警告, 不改变模型请求的结果. 已保存的记录不原地更新. 查询失败则向调用方抛错.

`list` 支持按 Session, 能力, 条数和游标查询, 按开始时间及 ID 倒序排列. 默认每页 100 条, 限制在 1 到 500 条. 翻页需要保留 `nextCursor` 的两个字段. `forTurn` 返回指定 Turn 的记录, 按时间和 ID 正序排列.

## 数字的含义

- 未取得或不适用的用量保持 `null`, 不代表 0 或免费.
- `inputTokens` 已包含缓存输入, 不要再次加上缓存读取或写入的 Token.
- `quantity` 必须结合 `unit` 读取. TTS 使用提交文本的 UTF-16 长度, 单位为 `character`; STT 使用已知音频秒数, 单位为 `second`.
- `durationMs` 是请求开始到返回或流结束的耗时, 不是生成音频的播放时长.
- 失败和取消的请求也可能产生用量.

## 接入与验证

[record.ts](record.ts) 保存字段映射和查询入口, [types.ts](types.ts) 说明用量含义. Storage 实现[数据库操作](../storage/repos/data/usage-records.ts). [Usage Route](../../apps/server/src/routes/usage.ts) 提供 `GET /api/usage/records`, 翻页参数 `beforeCreatedAt` 与 `beforeId` 必须一起提交. Usage 不发送变更事件, 消费方查询已保存记录.

运行 `pnpm --filter @ema-agent/usage test`. 测试使用真实的内存 SQLite, 检查字段转换, 终态, 翻页, SQL 拒绝非法记录及读写错误的不同处理.
