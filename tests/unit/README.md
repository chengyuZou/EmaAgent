# tests/unit

单元测试与集成测试基础设施。

## 定位

负责：
- 各 `packages/*` 的单元测试
- `orchestrator-runtime` 的集成测试（Mock Provider）
- `storage-sql` 的数据库迁移测试
- 契约测试（TS/Python schema 对齐验证）

## 目录结构

```
vitest.config.ts    # Vitest 配置（globals + node 环境）
package.json        # 测试包依赖（vitest + typescript）
tsconfig.json       # 测试专用 TS 配置
example.test.ts     # 示例测试（验证框架运行）
```

## 测试策略

### 单元测试（必写）

| 模块 | 必测内容 |
|---|---|
| `config-kernel` | `mergeConfigLayers` 边界（空对象、嵌套覆盖、undefined） |
| `tool-runtime` | `partitionToolCalls` 并发分区、`executeToolBatches` 异常兜底 |
| `sandbox-runtime` | 权限决策矩阵（风险级别 × 全权限开关） |
| `session-runtime` | 上下文窗口截断、消息追加 |

### Mock 策略

- **LLM Provider**：返回固定 `ChatCompletionChunk` 流
- **工具执行**：内存 mock，不碰真实文件系统
- **文件系统**：使用 `memfs` 替代真实 I/O

### 契约测试

每次修改 `core-types` 或 `schemas.py` 后，运行自动化对比脚本：
```bash
# 导出 TS 类型为 JSON Schema
# 导出 Pydantic 模型为 JSON Schema
# 对比两者差异
```

## 运行方式

```bash
cd tests/unit
pnpm test          # 单次运行
pnpm test:watch    # 监听模式
```

## 红线

1. **新增 runtime 模块必须附带测试**（至少覆盖 happy path）。
2. **Mock 必须可重复**：禁止在测试中依赖外部网络或随机数据。
