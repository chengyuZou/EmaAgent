/** 精确放行的变量名(比较时统一大写, Windows 环境大小写不敏感). */
const ALLOWED_EXACT = new Set([
  // 命令查找与系统
  'PATH', 'PATHEXT', 'COMSPEC', 'OS',
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE',
  // 用户目录(工具写配置/缓存的定位依据)
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  // 临时目录
  'TEMP', 'TMP', 'TMPDIR',
  // Git Bash / MSYS 运行必需
  'MSYSTEM', 'CHERE_INVOKING',
  // 语言区域(LANG 精确, LC_* 走前缀)
  'LANG',
]);

/** 前缀放行的变量名(统一大写后比较). */
const ALLOWED_PREFIXES = ['LC_'];

/**
 * 从空对象按允许名单复制环境变量, 不传递 API 凭据和 Shell 注入变量.
 * 设置 TERM=dumb, PAGER/GIT_PAGER=cat, 避免常用工具分页等待输入.
 */
export function buildProcessEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    const allowed =
      ALLOWED_EXACT.has(upper) || ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix));
    if (!allowed) continue;
    // 统一大写后写入. Path/PATH 等同名变体同时出现时, 后遍历的值覆盖前值.
    environment[upper] = value;
  }

  environment.TERM = 'dumb';
  environment.PAGER = 'cat';
  environment.GIT_PAGER = 'cat';
  return environment;
}
