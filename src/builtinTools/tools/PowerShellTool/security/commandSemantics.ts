// PowerShell 外部可执行文件的退出码语义解释(grep/findstr/robocopy 等)。
// 对照移植自 Claude packages/builtin-tools/src/tools/PowerShellTool/commandSemantics.ts。
//
// PowerShell 原生 cmdlet 不需要退出码语义:
//   - Select-String(grep 等价物)无匹配时退出码为 0(返回 $null)
//   - Compare-Object(diff 等价物)无论如何退出码都是 0
//   - Test-Path 无论如何退出码都是 0(经管道返回 bool)
// 原生 cmdlet 经终止错误($?)而非退出码表达失败。
//
// 但从 PowerShell 调用的外部可执行文件会设置 $LASTEXITCODE,且很多用
// 非零退出码传达信息而非失败:
//   - grep.exe / rg.exe(Git for Windows、scoop 等):1 = 无匹配
//   - findstr.exe(Windows 原生):1 = 无匹配
//   - robocopy.exe(Windows 原生):0-7 = 成功,8+ = 错误(臭名昭著!)
//
// 没有本模块,PowerShellTool 对任何非零退出都抛 ShellError,于是
// `robocopy` 报告"文件复制成功"(退出码 1)会显示为错误。

export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean;
  message?: string;
};

/**
 * 默认语义:只有 0 是成功,其余皆为错误
 */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
});

/**
 * grep / ripgrep:0 = 找到匹配,1 = 无匹配,2+ = 错误
 */
const GREP_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? 'No matches found' : undefined,
});

/**
 * 外部可执行文件的逐命令语义。
 * 键是不带 .exe 后缀的小写命令名。
 *
 * 刻意不收:
 *   - 'diff':有歧义。Windows PowerShell 5.1 把 `diff` 别名到
 *     Compare-Object(有差异也退出 0),但 PS Core / Git for Windows
 *     可能解析为 diff.exe(有差异退出 1)。无法可靠解释。
 *   - 'fc':有歧义。PowerShell 把 `fc` 别名到 Format-Custom(原生
 *     cmdlet),但 `fc.exe` 是 Windows 文件比较工具(退出 1 = 文件不同)。
 *     与 `diff` 同样的别名问题。
 *   - 'find':有歧义。Windows find.exe(文本搜索)与 Unix find.exe
 *     (Git for Windows 的文件搜索)语义不同。
 *   - 'test'、'[':不是 PowerShell 构造。
 *   - 'select-string'、'compare-object'、'test-path':原生 cmdlet 退出 0。
 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // 外部 grep/ripgrep(Git for Windows、scoop、choco)
  ['grep', GREP_SEMANTIC],
  ['rg', GREP_SEMANTIC],

  // findstr.exe:Windows 原生文本搜索
  // 0 = 找到匹配,1 = 无匹配,2 = 错误
  ['findstr', GREP_SEMANTIC],

  // robocopy.exe:Windows 原生健壮文件复制
  // 退出码是位图——0-7 是成功,8+ 表示至少一个失败:
  //   0 = 未复制文件,无不匹配,无失败(已同步)
  //   1 = 文件复制成功
  //   2 = 检测到多余文件/目录(未复制)
  //   4 = 检测到有差异的文件/目录
  //   8 = 部分文件/目录无法复制(复制错误)
  //  16 = 严重错误(robocopy 未复制任何文件)
  // 这是 Windows 上最常见的"CI 挂了但一切正常"陷阱。
  [
    'robocopy',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 8,
      message:
        exitCode === 0
          ? 'No files copied (already in sync)'
          : exitCode >= 1 && exitCode < 8
            ? exitCode & 1
              ? 'Files copied successfully'
              : 'Robocopy completed (no errors)'
            : undefined,
    }),
  ],
]);

/**
 * 从单个管道段提取命令名。
 * 剥掉开头的 `&` / `.` 调用运算符与 `.exe` 后缀,转小写。
 */
function extractBaseCommand(segment: string): string {
  // 剥 PowerShell 调用运算符:& "cmd"、. "cmd"
  // (段首的 & 和 . 后跟空白表示调用下一个 token)
  const stripped = segment.trim().replace(/^[&.]\s+/, '');
  const firstToken = stripped.split(/\s+/)[0] || '';
  // 命令以 & "grep.exe" 形式调用时剥掉外层引号
  const unquoted = firstToken.replace(/^["']|["']$/g, '');
  // 剥路径:C:\bin\grep.exe → grep.exe,.\rg.exe → rg.exe
  const basename = unquoted.split(/[\\/]/).pop() || unquoted;
  // 剥 .exe 后缀(Windows 大小写不敏感)
  return basename.toLowerCase().replace(/\.exe$/, '');
}

/**
 * 从 PowerShell 命令行提取主命令。
 * 取最后一个管道段,因为它决定退出码。
 *
 * 按 `;` 与 `|` 启发式切分——对带引号字符串或复杂构造可能切错。
 * 不要把它用于安全判断;它只用于退出码解释(假阴性只是退回默认语义)。
 */
function heuristicallyExtractBaseCommand(command: string): string {
  const segments = command.split(/[;|]/).filter(s => s.trim());
  const last = segments[segments.length - 1] || command;
  return extractBaseCommand(last);
}

/**
 * 按语义规则解释命令结果
 */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): {
  isError: boolean;
  message?: string;
} {
  const baseCommand = heuristicallyExtractBaseCommand(command);
  const semantic = COMMAND_SEMANTICS.get(baseCommand) ?? DEFAULT_SEMANTIC;
  return semantic(exitCode, stdout, stderr);
}
