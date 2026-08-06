// 检测潜在破坏性 PowerShell 命令,返回供权限对话框展示的警告文案。
// 纯信息提示——不影响权限判定与自动批准。
// 对照 Claude packages/builtin-tools/src/tools/PowerShellTool/destructiveCommandWarning.ts 逐行移植;
// warning 文案保留英文(模型/开发者可见,UI 本地化是展示层的事)。

type DestructivePattern = {
  pattern: RegExp;
  warning: string;
};

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  // Remove-Item 带 -Recurse 和/或 -Force(含常见别名)。
  // 锚定在语句起点(^、|、;、&、换行、{、(),这样 `git rm --force`
  // 不会误配——\b 会在任何词边界后匹配到 `rm`。`{(` 两个字符兜住
  // scriptblock/分组体:`{ rm -Force ./x }`。stopper 字符类只加 `}`
  // (不加 `)`)——`}` 结束一个块,块后的 flag 属于另一条语句
  // (`if {rm} else {... -Force}`);而 `)` 只是闭合路径分组,其后的
  // flag 仍是本命令的 flag:
  // `Remove-Item (Join-Path $r "tmp") -Recurse -Force` 必须仍然告警。
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Recurse\b[^|;&\n}]*-Force\b/i,
    warning: 'Note: may recursively force-remove files',
  },
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Force\b[^|;&\n}]*-Recurse\b/i,
    warning: 'Note: may recursively force-remove files',
  },
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Recurse\b/i,
    warning: 'Note: may recursively remove files',
  },
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Force\b/i,
    warning: 'Note: may force-remove files',
  },

  // Clear-Content 作用于宽泛路径
  {
    pattern: /\bClear-Content\b[^|;&\n]*\*/i,
    warning: 'Note: may clear content of multiple files',
  },

  // Format-Volume 与 Clear-Disk
  {
    pattern: /\bFormat-Volume\b/i,
    warning: 'Note: may format a disk volume',
  },
  {
    pattern: /\bClear-Disk\b/i,
    warning: 'Note: may clear a disk',
  },

  // Git 破坏性操作(与 BashTool 相同)
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    warning: 'Note: may discard uncommitted changes',
  },
  {
    pattern: /\bgit\s+push\b[^|;&\n]*\s+(--force|--force-with-lease|-f)\b/i,
    warning: 'Note: may overwrite remote history',
  },
  {
    pattern:
      /\bgit\s+clean\b(?![^|;&\n]*(?:-[a-zA-Z]*n|--dry-run))[^|;&\n]*-[a-zA-Z]*f/i,
    warning: 'Note: may permanently delete untracked files',
  },
  {
    pattern: /\bgit\s+stash\s+(drop|clear)\b/i,
    warning: 'Note: may permanently remove stashed changes',
  },

  // 数据库操作
  {
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    warning: 'Note: may drop or truncate database objects',
  },

  // 系统操作
  {
    pattern: /\bStop-Computer\b/i,
    warning: 'Note: will shut down the computer',
  },
  {
    pattern: /\bRestart-Computer\b/i,
    warning: 'Note: will restart the computer',
  },
  {
    pattern: /\bClear-RecycleBin\b/i,
    warning: 'Note: permanently deletes recycled files',
  },
];

/**
 * 检查 PowerShell 命令是否命中已知破坏性模式。
 * 返回人类可读的警告文案;未命中任何破坏性模式时返回 null。
 */
export function getDestructiveCommandWarning(command: string): string | null {
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return warning;
    }
  }
  return null;
}
