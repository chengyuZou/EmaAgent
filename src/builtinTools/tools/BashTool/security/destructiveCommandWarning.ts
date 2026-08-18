/**
 * 检测破坏性 bash 命令, 返回展示用警告文案(纯信息层, 不影响权限判定
 * 与自动放行)。
 */

type DestructivePattern = {
  pattern: RegExp
  warning: string
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  // Git — 数据丢失 / 难以回退
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    warning: '可能丢弃未提交修改',
  },
  {
    pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/,
    warning: '可能覆盖远端历史',
  },
  {
    pattern:
      /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/,
    warning: '可能永久删除未跟踪文件',
  },
  {
    pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: '可能丢弃工作区全部修改',
  },
  {
    pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: '可能丢弃工作区全部修改',
  },
  {
    pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/,
    warning: '可能永久移除暂存内容',
  },
  {
    pattern:
      /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/,
    warning: '可能强制删除分支',
  },

  // Git — 安全旁路
  {
    pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/,
    warning: '可能跳过安全钩子',
  },
  {
    pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/,
    warning: '可能改写上一次提交',
  },

  // 文件删除(危险路径由 pathValidation 的危险删除清单处理)
  {
    pattern:
      /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
    warning: '可能递归强制删除文件',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/,
    warning: '可能递归删除文件',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/,
    warning: '可能强制删除文件',
  },

  // 数据库
  {
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    warning: '可能删除或清空数据库对象',
  },
  {
    pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i,
    warning: '可能删除数据表全部行',
  },

  // 基础设施
  {
    pattern: /\bkubectl\s+delete\b/,
    warning: '可能删除 Kubernetes 资源',
  },
  {
    pattern: /\bterraform\s+destroy\b/,
    warning: '可能销毁 Terraform 基础设施',
  },
]

/**
 * Checks if a bash command matches known destructive patterns.
 * Returns a human-readable warning string, or null if no destructive pattern is detected.
 */
export function getDestructiveCommandWarning(command: string): string | null {
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return warning
    }
  }
  return null
}
