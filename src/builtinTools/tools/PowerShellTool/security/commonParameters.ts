// PowerShell 公共参数(所有 cmdlet 经 [CmdletBinding()] 都携带)。
// 来源: about_CommonParameters(PowerShell 文档)+ Get-Command 输出。
// 对照 Claude packages/builtin-tools/src/tools/PowerShellTool/commonParameters.ts 移植。
//
// 由 pathValidation.ts(并入各 cmdlet 的已知参数集合)与
// readOnlyValidation.ts(并入 safeFlags 检查)共享;独立成文件是为了
// 拆开这两个文件之间否则会形成的 import 环。
//
// 小写存储、带前导破折号——调用方对自己的输入 .toLowerCase() 后查表。

export const COMMON_SWITCHES = ['-verbose', '-debug'];

export const COMMON_VALUE_PARAMS = [
  '-erroraction',
  '-warningaction',
  '-informationaction',
  '-progressaction',
  '-errorvariable',
  '-warningvariable',
  '-informationvariable',
  '-outvariable',
  '-outbuffer',
  '-pipelinevariable',
];

export const COMMON_PARAMETERS: ReadonlySet<string> = new Set([
  ...COMMON_SWITCHES,
  ...COMMON_VALUE_PARAMS,
]);
