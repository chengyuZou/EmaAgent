// 子进程环境净化: 不继承宿主环境再删 Key, 而是清空后按白名单重建(Codex 同款方向)。
// API Key/Token/Secret/SSH/注入类变量(BASH_ENV/NODE_OPTIONS/LD_PRELOAD 等)默认不存在。
// 白名单刻意最小: 没有 USER/LOGNAME/XDG_*/DISPLAY 不是遗漏——沙箱命令不应开 GUI,
// 配置/缓存默认落 HOME 与临时目录即可;少暴露一个变量就少一条宿主信息泄漏通道。

// ── 白名单 ────────────────────────────────────────────────────────────────────

/** 精确放行的变量名(比较时统一大写, Windows 环境大小写不敏感)。 */
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

/** 前缀放行的变量名(统一大写后比较)。 */
const ALLOWED_PREFIXES = ['LC_'];

/**
 * 为沙箱子进程重建环境。只保留运行命令必需的查找/目录/区域变量,
 * 并强制非交互终端行为(TERM=dumb 不分页, PAGER/GIT_PAGER=cat)。
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
    // Windows 环境变量大小写不敏感, 统一大写键避免 Path/PATH 重复。
    // POSIX 下白名单内变量本就是大写约定, 大写化同样无害;
    // 极端情况(POSIX source 里 Path/PATH 真共存)后者胜出, 现实中不出现。
    environment[upper] = value;
  }

  environment.TERM = 'dumb';
  environment.PAGER = 'cat';
  environment.GIT_PAGER = 'cat';
  return environment;
}
