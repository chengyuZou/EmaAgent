/**
 * 接受 -FilePath(或位置路径参数)并把文件内容当脚本执行的 cmdlet.
 */
export const FILEPATH_EXECUTION_CMDLETS = new Set([
  'invoke-command',
  'start-job',
  'start-threadjob',
  'register-scheduledjob',
]);

/**
 * scriptblock 参数会执行任意代码的 cmdlet(区别于 Where-Object 那种
 * 只过滤/变换管道输入的用法).
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
 * 加载并执行模块/脚本代码的 cmdlet.`.psm1` 文件在 import 时会执行
 * 顶层体 - 与 iex 同等的代码执行风险.
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
