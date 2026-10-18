import type { SandboxBackend, SandboxConfig, ShellSpec, WrappedCommand } from '../types.js';

/**
 * 通过 -p 传入 SBPL 规则. 从 deny default 开始, 允许读取及必要进程操作,
 * 只开放指定目录的写入, 再覆盖显式禁止路径. 网络使用 none/full 两档.
 */
export class SandboxExecBackend implements SandboxBackend {
  wrap(command: string, shell: ShellSpec, config: SandboxConfig): WrappedCommand {
    const profile = buildProfile(config);

    // spawn 直接传 argv, 不经过外层 Shell: 命令不能再包一层引号,
    // 否则引号会成为 bash -c 输入的一部分, 整条命令被解释成一个"命令名".
    // macOS 上 shell 恒为 native 路径; wsl 形态不可达, 防御性回退.
    const shellPath = shell.kind === 'native' ? shell.path : 'bash';
    return {
      executable: 'sandbox-exec',
      args: ['-p', profile, shellPath, '-c', command],
    };
  }
}

/** 路径放在 SBPL 双引号字符串里, 需要转义双引号和反斜杠. */
function escapeSbplPath(p: string): string {
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

    // 全局可读(对齐 bwrap 的 --ro-bind / /)
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

  // 显式拒绝写入(覆盖 allowWrite 父目录)
  for (const p of config.filesystem.denyWrite) {
    rules.push(`(deny file-write* (subpath "${escapeSbplPath(p)}"))`);
  }

  // 默认规则拒绝网络, 因此 full 也必须明确添加 allow, 不能只省略 deny.
  if (config.network.access === 'none') {
    rules.push('(deny network-outbound)');
    rules.push('(deny network-inbound)');
  } else {
    rules.push('(allow network-outbound)');
    rules.push('(allow network-inbound)');
  }

  return rules.join('\n');
}
