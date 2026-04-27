# @ema-agent/sandbox-runtime

## 一句话职责

权限控制与安全沙箱：文件系统访问控制、命令执行沙箱、权限引擎。

## 上游依赖（我可以 import 谁）

- `@ema-agent/core-types` —— 权限类型、Sandbox 配置
- `@ema-agent/constants-core` —— 安全相关常量

## 下游消费者（谁可以 import 我）

- `@ema-agent/tool-runtime` —— 执行危险命令前调用沙箱
- `@ema-agent/orchestrator-runtime` —— Agent 模式权限检查
- `@ema-agent/api-gateway` —— 权限查询接口

## 对外接口

- `export interface PermissionEngine` —— 权限引擎接口
- `export class CommandSandbox` —— 命令执行沙箱
- `export function checkPermission()` —— 权限检查

## 禁止事项

- ❌ 禁止 import `tool-runtime`（tool 调用 sandbox，不是反过来）
- ❌ 禁止 import `orchestrator-runtime`（防止循环）
- ❌ 禁止在沙箱里执行业务逻辑（只负责"允许/拒绝/拦截"）
- ❌ 禁止绕过自身权限检查执行操作
