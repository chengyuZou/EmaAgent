// 为 macOS sandbox-exec 生成文件和网络隔离规则。

import type { SandboxBackend, SandboxConfig, WrappedCommand } from '../types.js';

/**
 * macOS sandbox-exec 后端。
 *
 * 用 Apple 的 Sandbox Profile Language（SBPL）经 `-p` 内联传入。
 * sandbox-exec 自 macOS 12 起标记 deprecated，但仍可用。
 *
 * Profile 策略：
 *   - 默认允许所有读取（对齐 bwrap 行为）
 *   - 全局拒绝写入，再允许特定可写路径
 *   - 网络：无允许域名则全拒
 */
export class SandboxExecBackend implements SandboxBackend {
  readonly name = 'sandbox-exec';

  wrap(command: string, shell: string, config: SandboxConfig): WrappedCommand {
    const profile = buildProfile(config);
    const escaped = command.replace(/'/g, "'\\''");

    return {
      executable: 'sandbox-exec',
      args: ['-p', profile, shell, '-c', `'${escaped}'`],
    };
  }
}

// ── SBPL profile builder ──────────────────────────────────────────────────────

/**
 * 转义路径中的 SBPL 特殊字符（" 和 )），防止路径破坏 profile 语法或注入规则。
 * 路径来源虽相对可信（Core/permission），但纵深防御该转义。
 */
function escapeSbplPath(p: string): string {
  // SBPL 字符串用双引号包裹，转义双引号和反斜杠。
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildProfile(config: SandboxConfig): string {
  const rules: string[] = [
    '(version 1)',
    '(deny default)',

    // 进程控制 - 每条命令都需要
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach*)',

    // 全局可读（对齐 bwrap 的 --ro-bind / /）
    '(allow file-read*)',
  ];

  // 显式拒绝读取
  for (const p of config.filesystem.denyRead) {
    rules.push(`(deny file-read* (subpath "${escapeSbplPath(p)}"))`);
  }

  // 可写路径
  for (const p of config.filesystem.allowWrite) {
    rules.push(`(allow file-write* (subpath "${escapeSbplPath(p)}"))`);
  }

  // 显式拒绝写入（覆盖 allowWrite 父目录）
  for (const p of config.filesystem.denyWrite) {
    rules.push(`(deny file-write* (subpath "${escapeSbplPath(p)}"))`);
  }

  // V1 不生成域名字符串规则：none 完全断网，full 不添加网络限制。
  if (config.network.access === 'none') {
    rules.push('(deny network-outbound)');
    rules.push('(deny network-inbound)');
  }

  return rules.join('\n');
}
