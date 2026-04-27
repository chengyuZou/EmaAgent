# @ema-agent/config-kernel

## 一句话职责

配置 schema 定义、默认值、分层 merge、配置持久化。纯数据层，与运行时无关。

## 上游依赖（我可以 import 谁）

- `@ema-agent/constants-core` —— 配置相关常量

## 下游消费者（谁可以 import 我）

- `@ema-agent/orchestrator-runtime` —— 启动时读取配置
- `@ema-agent/api-gateway` —— 提供配置接口
- `@ema-agent/desktop-shell` —— 读取用户设置

## 对外接口

- `export interface AppConfig` —— 全量配置结构
- `export function mergeConfigLayers()` —— 多层配置合并
- `export function resolveConfigForSession()` —— 会话级配置解析
- `export const DEFAULT_APP_CONFIG` —— 默认配置

## 禁止事项

- ❌ 禁止 import 任何 runtime 包
- ❌ 禁止直接读取文件系统（当前版本；未来可扩展 loader 层）
- ❌ 禁止包含与环境相关的副作用（如 `process.env` 应在 gateway 层处理）
