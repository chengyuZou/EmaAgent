# @ema-agent/storage-sql

## 一句话职责

SQLite 持久化层的 Repository 实现。提供会话、用户画像、附件元数据等的 CRUD。

## 上游依赖（我可以 import 谁）

- `@ema-agent/core-types` —— 数据契约（Session、UserProfile 等）
- `@ema-agent/constants-core` —— 常量

## 下游消费者（谁可以 import 我）

- `@ema-agent/session-runtime` —— 通过 SessionRepo 读写会话
- `@ema-agent/memory-runtime` —— 通过 UserProfileRepo 读写画像

## 对外接口

- `export interface SessionRepo` —— 会话仓库接口
- `export interface UserProfileRepo` —— 用户画像仓库接口
- `export function createDatabase()` —— 数据库初始化

## 禁止事项

- ❌ **禁止 import 任何 runtime 包**（session-runtime、memory-runtime、orchestrator-runtime 等）
- ❌ 禁止包含业务逻辑（如压缩策略、召回逻辑）
- ❌ 禁止直接暴露 SQL 语句给 consumer
- ❌ 禁止持有运行时状态（如当前会话缓存）
