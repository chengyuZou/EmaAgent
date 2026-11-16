# System

[English](README.md)

System 提供本机磁盘信息, 可用内存查询以及应用警告共用的 `SystemWarningEvent` 类型.

```ts
import { checkAvailableMemory, getDisksInfo } from '@ema-agent/system';

const disks = getDisksInfo();
const availableBytes = checkAvailableMemory();
```

`checkAvailableMemory()` 在 Windows, macOS 和 Linux 上统一封装 `process.availableMemory()`, 校验结果为有限非负字节数并在读取失败时直接抛错. Tools 在启动 Shell 命令前调用它检查可用内存.

`getDisksInfo()` 同步返回每个磁盘的挂载位置, 卷标, 总字节数和未用字节数. Windows 通过 PowerShell 查询 `Win32_LogicalDisk`, 明确输出 UTF-8 JSON, 避免卷标解码错误. macOS 和 Linux 执行 `df -Pk`, 将 1024 字节块换算为字节.

POSIX 的 `free` 使用总量减已用量, 不是命令中普通用户可用空间那一列, 可能包含用户无法使用的保留空间. 当前按列拆分的解析方式不能还原包含空白的挂载路径. 命令超时为 5 秒, 执行或解析失败返回空列表.

[Server 状态 Route](../../apps/server/src/routes/system/status.ts) 将磁盘列表和当前数据目录一起返回给前端. 数据目录由 Server 提供, 不从磁盘信息推测.

`SystemWarningEvent` 包含 `type: 'system_warning'`, 级别和展示给用户的消息. 自动截图等生产方通过 Server 应用事件发布, Desktop 的通知处理代码负责显示.

磁盘查询位于 [disk.ts](disk.ts), 内存检查位于 [checkAvailableMemory.ts](checkAvailableMemory.ts), 警告类型位于 [events.ts](events.ts). 运行 `pnpm --filter @ema-agent/system typecheck` 和 `pnpm --filter @ema-agent/system test`. 单元测试 `tests/checkAvailableMemory.test.ts` 覆盖内存检查; 平台磁盘命令目前没有自动化测试.
