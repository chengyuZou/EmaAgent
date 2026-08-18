// 会执行任意代码的 PowerShell cmdlet 共享常量表。
// 对照 Claude src/utils/powershell/dangerousCmdlets.ts 逐行移植;
// CROSS_PLATFORM_CODE_EXEC 从 Claude src/utils/permissions/dangerousPatterns.ts 内联至此。
//
// 这些清单同时被权限引擎校验器(powershellSecurity.ts)与 UI 建议门
// (staticPrefix.ts)消费。集中放在这里避免两份清单各自漂移——
// 加一次 cmdlet,两个消费方同时生效。
import { COMMON_ALIASES } from '../psParser.js';

/**
 * 跨平台代码执行入口:Unix 与 Windows 上都存在。
 * 与 Bash 侧共享的跨平台代码执行入口清单,单一事实源在此文件——
 * Bash 权限判定需要时从这里 import,禁止另抄一份。
 *
 * Claude 侧它住在 src/utils/permissions/dangerousPatterns.ts,喂给
 * isDangerous{Bash,PowerShell}Permission 判定:`Bash(python:*)`、
 * `PowerShell(node:*)` 这类允许规则等于让模型经解释器执行任意代码、
 * 绕过 auto-mode 分类器,进入 auto-mode 时必须剥离这类规则。
 */
export const CROSS_PLATFORM_CODE_EXEC = [
  // 解释器
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'tsx',
  'ruby',
  'perl',
  'php',
  'lua',
  // 包运行器
  'npx',
  'bunx',
  'npm run',
  'yarn run',
  'pnpm run',
  'bun run',
  // 两侧都可达的 shell(Windows 上的 Git Bash / WSL,Unix 原生)
  'bash',
  'sh',
  // 远程任意命令包装(Win10+ 自带的原生 OpenSSH)
  'ssh',
] as const;

/**
 * 接受 -FilePath(或位置路径参数)并把文件内容当脚本执行的 cmdlet。
 */
export const FILEPATH_EXECUTION_CMDLETS = new Set([
  'invoke-command',
  'start-job',
  'start-threadjob',
  'register-scheduledjob',
]);

/**
 * scriptblock 参数会执行任意代码的 cmdlet(区别于 Where-Object 那种
 * 只过滤/变换管道输入的用法)。
 */
export const DANGEROUS_SCRIPT_BLOCK_CMDLETS = new Set([
  'invoke-command',
  'invoke-expression',
  'start-job',
  'start-threadjob',
  'register-scheduledjob',
  'register-engineevent',
  'register-objectevent',
  'register-wmievent',
  'new-pssession',
  'enter-pssession',
]);

/**
 * 加载并执行模块/脚本代码的 cmdlet。`.psm1` 文件在 import 时会执行
 * 顶层体——与 iex 同等的代码执行风险。
 */
export const MODULE_LOADING_CMDLETS = new Set([
  'import-module',
  'ipmo',
  'install-module',
  'save-module',
  'update-module',
  'install-script',
  'save-script',
]);

/**
 * shell 与进程启动器。小清单、稳定——只为上面校验器清单未覆盖的
 * cmdlet 才往这里加。
 */
const SHELLS_AND_SPAWNERS = [
  'pwsh',
  'powershell',
  'cmd',
  'bash',
  'wsl',
  'sh',
  'start-process',
  'start',
  'add-type',
  'new-object',
] as const;

function aliasesOf(targets: ReadonlySet<string>): string[] {
  return Object.entries(COMMON_ALIASES)
    .filter(([, target]) => targets.has(target.toLowerCase()))
    .map(([alias]) => alias);
}

/**
 * 网络 cmdlet——对这些命令的通配规则会不经提示放行外发/下载。
 * 不存在合法的窄前缀。
 */
export const NETWORK_CMDLETS = new Set([
  'invoke-webrequest',
  'invoke-restmethod',
]);

/**
 * 别名/变量改写 cmdlet——Set-Alias 重绑命令解析,Set-Variable 可污染
 * $PSDefaultParameterValues。powershellSecurity.ts 的
 * checkRuntimeStateManipulation 校验器在权限路径上独立把守。
 */
export const ALIAS_HIJACK_CMDLETS = new Set([
  'set-alias',
  'sal', // 别名不在 COMMON_ALIASES 中——显式列出
  'new-alias',
  'nal', // 别名不在 COMMON_ALIASES 中——显式列出
  'set-variable',
  'sv', // 别名不在 COMMON_ALIASES 中——显式列出
  'new-variable',
  'nv', // 别名不在 COMMON_ALIASES 中——显式列出
]);

/**
 * WMI/CIM 进程启动——Invoke-WmiMethod -Class Win32_Process -Name Create
 * 是绕过 checkStartProcess 的 Start-Process 等价物。不存在合法的窄前缀;
 * 任何调用都能启动任意进程。checkWmiProcessSpawn 校验器在权限路径上把守。
 * (security finding #34)
 */
export const WMI_CIM_CMDLETS = new Set([
  'invoke-wmimethod',
  'iwmi', // 别名不在 COMMON_ALIASES 中——显式列出
  'invoke-cimmethod',
]);

/**
 * CMDLET_ALLOWLIST 中带 additionalCommandIsDangerousCallback 的 cmdlet。
 *
 * allowlist 对安全参数(StringConstant 标识符)自动放行这些 cmdlet。
 * 权限对话框只在回调拒绝时弹出——即参数含 scriptblock、变量、子表达式等。
 * 此时若接受 `Cmdlet:*` 通配规则,今后所有调用都会经 prefix-startsWith
 * 命中,永久绕过回调。
 * `ForEach-Object:*` → `ForEach-Object { Remove-Item -Recurse / }` 就被自动放行。
 *
 * 与 readOnlyValidation.ts 保持同步——对应测试
 * (Claude 侧 test/utils/powershell/dangerousCmdlets.test.ts)断言本集合
 * 覆盖每个 additionalCommandIsDangerousCallback 条目。
 */
export const ARG_GATED_CMDLETS = new Set([
  'select-object',
  'sort-object',
  'group-object',
  'where-object',
  'measure-object',
  'write-output',
  'write-host',
  'start-sleep',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  'out-string',
  'out-host',
  // 带回调门控参数的原生可执行文件(如 ipconfig /flushdns 被拒、
  // ipconfig /all 放行)。绕过风险相同。
  'ipconfig',
  'hostname',
  'route',
]);

/**
 * 权限对话框中永远不得建议为通配前缀的命令。
 *
 * 派生自上面的校验器清单加一小份静态 shell 清单。把 cmdlet 加进合适的
 * 校验器清单就会自动出现在这里——无需单独维护。
 */
export const NEVER_SUGGEST: ReadonlySet<string> = (() => {
  const core = new Set<string>([
    ...SHELLS_AND_SPAWNERS,
    ...FILEPATH_EXECUTION_CMDLETS,
    ...DANGEROUS_SCRIPT_BLOCK_CMDLETS,
    ...MODULE_LOADING_CMDLETS,
    ...NETWORK_CMDLETS,
    ...ALIAS_HIJACK_CMDLETS,
    ...WMI_CIM_CMDLETS,
    ...ARG_GATED_CMDLETS,
    // ForEach-Object 的 -MemberName(位置参数:`% Delete`)针对运行时管道
    // 对象解析——`Get-ChildItem | % Delete` 会调用 FileInfo.Delete()。
    // StaticParameterBinder 能识别 PropertyAndMethodSet 参数集,但本集合两种
    // 形态都要管;该参数只是普通 StringConstantExpressionAst,没有属性/方法
    // 信号。管道类型推断(上游 OutputType → GetMember)漏掉 ETS AliasProperty
    // 成员,对 `$var | %` 或外部上游也没有答案。不在 ARG_GATED(没有需要
    // 同步的 allowlist 条目)。
    'foreach-object',
    // 解释器/运行器——`node script.js` 停在文件参数处并建议裸 `node:*`,
    // 从而经 -e/-p 自动放行任意代码。auto-mode 分类器会剥离这类规则
    // (isDangerousPowerShellPermission),但建议门没有。多词条目
    // ('npm run')被过滤掉——NEVER_SUGGEST 是对 cmd.name 的单词查找。
    ...CROSS_PLATFORM_CODE_EXEC.filter((p) => !p.includes(' ')),
  ]);
  return new Set([...core, ...aliasesOf(core)]);
})();
