import { isInternalEnvironmentVariable, type CommandEnvironment } from '../commandEnvironment.js';

/** 精确放行的变量名(比较时统一大写, Windows 环境大小写不敏感). */
const ALLOWED_EXACT = new Set([
  // 命令查找与系统
  'PATH', 'PATHEXT', 'COMSPEC', 'OS',
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE',
  // 用户目录(工具写配置/缓存的定位依据)
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  // 临时目录
  'TEMP', 'TMP', 'TMPDIR',
  // Git Bash / MSYS 运行必需
  'MSYSTEM', 'CHERE_INVOKING',
  // 语言区域(LANG 精确, LC_* 走前缀)
  'LANG', 'TZ',
]);

/** 前缀放行的变量名(统一大写后比较). */
const ALLOWED_PREFIXES = ['LC_'];

/**
 * 默认只复制命令运行需要的环境变量. 其他凭据由用户显式选择, Ema 控制口令始终禁止传递.
 * 设置 TERM=dumb, PAGER/GIT_PAGER=cat, 避免常用工具分页等待输入.
 */
export function buildProcessEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
  selected?: Readonly<CommandEnvironment>,
): Record<string, string> {
  const environment: Record<string, string> = Object.create(null);

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

  const assignSelected = (name: string, value: string | undefined): void => {
    if (isInternalEnvironmentVariable(name)) {
      throw new Error('Ema control credentials cannot be forwarded to child processes.');
    }
    if (value === undefined) return;
    const outputName = process.platform === 'win32' ? name.toUpperCase() : name;
    environment[outputName] = value;
  };

  for (const name of selected?.passthrough ?? []) {
    const sourceName = process.platform === 'win32'
      ? Object.keys(source).find(key => key.toUpperCase() === name.toUpperCase())
      : name;
    assignSelected(name, sourceName === undefined ? undefined : source[sourceName]);
  }
  
  for (const [name, value] of Object.entries(selected?.values ?? {})) {
    assignSelected(name, value);
  }
  return environment;
}

