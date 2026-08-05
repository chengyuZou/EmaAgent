// 为 macOS sandbox-exec 生成文件和网络隔离规则。

import type { SandboxBackend, SandboxConfig, ShellSpec, WrappedCommand } from '../types.js';

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
  readonly kind = 'sandbox-exec';

  wrap(command: string, shell: ShellSpec, config: SandboxConfig): WrappedCommand {
    const profile = buildProfile(config);

    // spawn 直接传 argv, 不经过外层 Shell——命令不能再包一层引号,
    // 否则引号会成为 bash -c 输入的一部分, 整条命令被解释成一个"命令名"。
    // macOS 上 shell 恒为 native 路径; wsl 形态不可达, 防御性回退。
    const shellPath = shell.kind === 'native' ? shell.path : 'bash';
    return {
      executable: 'sandbox-exec',
      args: ['-p', profile, shellPath, '-c', command],
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

  // V1 不生成域名字符串规则。none 完全断网; full 必须显式开放——
  // profile 以 (deny default) 起手, 不写 allow 等于 full 也断网(P1 回归)。
  if (config.network.access === 'none') {
    rules.push('(deny network-outbound)');
    rules.push('(deny network-inbound)');
  } else {
    rules.push('(allow network-outbound)');
    rules.push('(allow network-inbound)');
  }

  return rules.join('\n');
}
