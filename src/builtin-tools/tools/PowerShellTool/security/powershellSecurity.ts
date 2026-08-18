// PowerShell 命令的 AST 安全分析：检测代码注入、下载执行、提权、动态命令名、COM 对象等危险模式。
//
// 所有检查均基于 AST。解析失败（valid=false）时各检查都不会命中，
// powershellCommandIsSafe 返回 'ask' 作为安全默认值。
//
// 与 Claude 原版的有意差异：结果类型为三档（deny / ask / passthrough）。
// 仅 checkDownloadCradles 与 checkEncodedCommand 返回 'deny'（对 Agent 无合法用途，
// 硬拦在权限层之前）；其余验证器与 Claude 一致返回 'ask'，交由用户裁决。

import {
  DANGEROUS_SCRIPT_BLOCK_CMDLETS,
  FILEPATH_EXECUTION_CMDLETS,
  MODULE_LOADING_CMDLETS,
} from './dangerousCmdlets.js'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../psParser.js'
import {
  COMMON_ALIASES,
  commandHasArgAbbreviation,
  deriveSecurityFlags,
  getAllCommands,
  getVariablesByScope,
  hasCommandNamed,
} from '../psParser.js'
import { isClmAllowedType } from './clmTypes.js'

export type PowerShellSecurityResult = {
  behavior: 'deny' | 'ask' | 'passthrough'
  message?: string
}

const POWERSHELL_EXECUTABLES = new Set([
  'pwsh',
  'pwsh.exe',
  'powershell',
  'powershell.exe',
])

/**
 * 从命令名中提取基础可执行文件名，兼容完整路径，
 * 如 /usr/bin/pwsh、C:\Windows\...\powershell.exe 或 .\pwsh。
 */
function isPowerShellExecutable(name: string): boolean {
  const lower = name.toLowerCase()
  if (POWERSHELL_EXECUTABLES.has(lower)) {
    return true
  }
  // 从路径中提取 basename（同时兼容 / 与 \ 分隔符）
  const lastSep = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
  if (lastSep >= 0) {
    return POWERSHELL_EXECUTABLES.has(lower.slice(lastSep + 1))
  }
  return false
}

/**
 * PowerShell 接受为 ASCII hyphen-minus（U+002D）等价物的替代参数前缀字符。
 * PowerShell 的 tokenizer（SpecialCharacters.IsDash）与 powershell.exe 的
 * CommandLineParameterParser 都接受全部四个 dash 字符，外加 Windows PowerShell 5.1
 * 的 `/` 参数分隔符。Extent.Text 保留原始字符；transformCommandAst 对
 * CommandParameterAst 元素使用 ce.text，因此这些字符原样到达我们这里。
 */
const PS_ALT_PARAM_PREFIXES = new Set([
  '/', // Windows PowerShell 5.1（powershell.exe，不含 pwsh 7+）
  '\u2013', // en-dash
  '\u2014', // em-dash
  '\u2015', // horizontal bar
])

/**
 * commandHasArgAbbreviation 的包装：同时匹配替代参数前缀
 * （`/`、en-dash、em-dash、horizontal-bar）。PowerShell 的 tokenizer
 * （SpecialCharacters.IsDash）对 powershell.exe 参数和 cmdlet 参数都接受这些前缀，
 * 因此所有 PS 参数检查都必须使用本函数 —— 不仅是 pwsh.exe 调用。
 * 此前 checkComObject/checkStartProcess/checkDangerousFilePathExecution/
 * checkForEachMemberName 直接使用裸 commandHasArgAbbreviation，
 * 导致 `Start-Process foo –Verb RunAs` 可绕过。
 */
function psExeHasParamAbbreviation(
  cmd: ParsedCommandElement,
  fullParam: string,
  minPrefix: string,
): boolean {
  if (commandHasArgAbbreviation(cmd, fullParam, minPrefix)) {
    return true
  }
  // 把替代前缀归一化为 `-` 后重新检查。构造一个参数归一化的合成 cmd；
  // commandHasArgAbbreviation 内部会处理冒号分隔的值。
  const normalized: ParsedCommandElement = {
    ...cmd,
    args: cmd.args.map(a =>
      a.length > 0 && PS_ALT_PARAM_PREFIXES.has(a[0]!) ? '-' + a.slice(1) : a,
    ),
  }
  return commandHasArgAbbreviation(normalized, fullParam, minPrefix)
}

/**
 * 检查 PowerShell 命令是否使用 Invoke-Expression 或其别名（iex）。
 * 它们等价于 eval，可执行任意代码。
 */
function checkInvokeExpression(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (hasCommandNamed(parsed, 'Invoke-Expression')) {
    return {
      behavior: 'ask',
      message:
        'Command uses Invoke-Expression which can execute arbitrary code',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查动态命令调用：命令名本身是一个无法静态解析的表达式。
 *
 * PoC：
 *   & ${function:Invoke-Expression} 'payload'  — VariableExpressionAst
 *   & ('iex','x')[0] 'payload'                 — IndexExpressionAst → 'Other'
 *   & ('i'+'ex') 'payload'                     — BinaryExpressionAst → 'Other'
 *
 * 以上情形中 cmd.name 是字面 extent 文本（如 "('iex','x')[0]"），
 * 不匹配 hasCommandNamed('Invoke-Expression')。运行时 PowerShell 会把该表达式
 * 求值为命令名并调用。
 *
 * 合法命令名永远是 StringConstantExpressionAst（映射为 'StringConstant'）：
 * `Get-Process`、`git`、`ls`。name 位置出现任何其他元素类型即为动态。
 * 与其把动态类型列入 denylist（脆弱 —— mapElementType 的 default 分支把未知
 * AST 类型映射为 'Other'，`=== 'Variable'` 检查会漏掉），不如 allowlist
 * 'StringConstant'。
 *
 * elementTypes[0] 是命令名元素（transformCommandAst 先于参数元素压入它）。
 * `!== undefined` 守卫在 elementTypes 缺失时保持 fail-open（解析细节不可用 ——
 * 如果整个解析失败，valid=false 会在链条更早处返回 'ask'）。
 */
function checkDynamicCommandName(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.elementType !== 'CommandAst') {
      continue
    }
    const nameElementType = cmd.elementTypes?.[0]
    if (nameElementType !== undefined && nameElementType !== 'StringConstant') {
      return {
        behavior: 'ask',
        message:
          'Command name is a dynamic expression which cannot be statically validated',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查用于掩盖意图的编码命令参数。
 * 这是恶意软件绕过安全工具的常用手段。
 *
 * Ema 有意偏离 Claude：返回 'deny'。base64 混淆命令对 Agent 没有合法用途
 * （模型完全可以写明文命令），因此硬拦，不进入权限层。
 */
function checkEncodedCommand(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      if (psExeHasParamAbbreviation(cmd, '-encodedcommand', '-e')) {
        return {
          behavior: 'deny',
          message: 'Command uses encoded parameters which obscure intent',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 PowerShell 再调用（嵌套 pwsh/powershell 进程）。
 *
 * 命令位置出现任何 PowerShell 可执行文件即标记 —— 不限于 -Command/-File。
 * 裸 `pwsh` 接收 stdin（`Get-Content x | pwsh`）或位置参数脚本路径同样会执行
 * 任意代码，且没有任何显式标志。与 checkStartProcess 的向量 2 同理：
 * 无法静态分析子进程将运行什么。
 */
function checkPwshCommandOrFile(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      return {
        behavior: 'ask',
        message:
          'Command spawns a nested PowerShell process which cannot be validated',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 download cradle 模式 —— 下载并执行远程代码的常见恶意软件手法。
 *
 * 单语句：捕获管道 cradle（`IWR ... | IEX`）。
 * 跨语句：捕获拆分 cradle（`$r = IWR ...; IEX $r.Content`）。
 * 跨语句情形本来已被 checkInvokeExpression（扫描所有语句）拦截，
 * 本检查用于改进警告文案。
 *
 * Ema 有意偏离 Claude：返回 'deny'。下载并执行远程代码对 Agent 没有合法用途，
 * 因此硬拦，不进入权限层。
 */
const DOWNLOADER_NAMES = new Set([
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'new-object',
  'start-bitstransfer', // MITRE T1197
])

function isDownloader(name: string): boolean {
  return DOWNLOADER_NAMES.has(name.toLowerCase())
}

function isIex(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'invoke-expression' || lower === 'iex'
}

function checkDownloadCradles(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 单语句：管道 cradle（IWR ... | IEX）
  for (const statement of parsed.statements) {
    const cmds = statement.commands
    if (cmds.length < 2) {
      continue
    }
    const hasDownloader = cmds.some(cmd => isDownloader(cmd.name))
    const hasIex = cmds.some(cmd => isIex(cmd.name))
    if (hasDownloader && hasIex) {
      return {
        behavior: 'deny',
        message: 'Command downloads and executes remote code',
      }
    }
  }

  // 跨语句：拆分 cradle（$r = IWR ...; IEX $r.Content）。
  // 不产生新的误报：只要 IEX 出现，checkInvokeExpression 本来就会拦截。
  const all = getAllCommands(parsed)
  if (all.some(c => isDownloader(c.name)) && all.some(c => isIex(c.name))) {
    return {
      behavior: 'deny',
      message: 'Command downloads and executes remote code',
    }
  }

  return { behavior: 'passthrough' }
}

/**
 * 检查独立下载工具 —— 常用于抓取 payload 的 LOLBAS 工具。
 * 与 checkDownloadCradles（要求同一管道内 下载 + IEX）不同，
 * 本检查标记下载操作本身。
 *
 * Start-BitsTransfer：永远是文件传输（MITRE T1197）。
 * certutil -urlcache：经典 LOLBAS 下载。仅带 -urlcache 时标记；
 * 裸 `certutil` 有大量合法证书管理用途。
 * bitsadmin /transfer：旧式 BITS 下载（早于 PowerShell）。
 */
function checkDownloadUtilities(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    // Start-BitsTransfer 专为文件传输而设 —— 不存在安全变体。
    if (lower === 'start-bitstransfer') {
      return {
        behavior: 'ask',
        message: 'Command downloads files via BITS transfer',
      }
    }
    // certutil / certutil.exe —— 仅当存在 -urlcache 时标记。certutil 有大量
    // 非下载用途（证书库查询、编码等）。按 Windows 工具惯例，certutil.exe
    // 同时接受 -urlcache 和 /urlcache —— 两种形式都检查（下面的 bitsadmin 同理）。
    if (lower === 'certutil' || lower === 'certutil.exe') {
      const hasUrlcache = cmd.args.some(a => {
        const la = a.toLowerCase()
        return la === '-urlcache' || la === '/urlcache'
      })
      if (hasUrlcache) {
        return {
          behavior: 'ask',
          message: 'Command uses certutil to download from a URL',
        }
      }
    }
    // bitsadmin /transfer —— 旧式 BITS CLI，威胁与 Start-BitsTransfer 相同。
    if (lower === 'bitsadmin' || lower === 'bitsadmin.exe') {
      if (cmd.args.some(a => a.toLowerCase() === '/transfer')) {
        return {
          behavior: 'ask',
          message: 'Command downloads files via BITS transfer',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 Add-Type 用法：它在运行时编译并加载 .NET 代码，
 * 可被用于执行任意编译后的代码。
 */
function checkAddType(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (hasCommandNamed(parsed, 'Add-Type')) {
    return {
      behavior: 'ask',
      message: 'Command compiles and loads .NET code',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 New-Object -ComObject。WScript.Shell、Shell.Application、
 * MMC20.Application、Schedule.Service、Msxml2.XMLHTTP 等 COM 对象自带
 * 执行/下载能力 —— 无需 IEX。
 *
 * 无法枚举所有危险 ProgID，因此标记任意 -ComObject。仅创建对象本身是惰性的，
 * 但提示应告知用户 COM 实例化是一种执行原语。对结果的方法调用
 * （.Run()、.Exec()）由 checkMemberInvocations 单独捕获。
 */
function checkComObject(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.name.toLowerCase() !== 'new-object') {
      continue
    }
    // -ComObject 的最小缩写是 -com（New-Object 参数：-TypeName、-ComObject、
    // -ArgumentList、-Property、-Strict；由于 -Confirm 等 common 参数，
    // -co 在 PS5.1 中有歧义，故用 -com）。
    if (psExeHasParamAbbreviation(cmd, '-comobject', '-com')) {
      return {
        behavior: 'ask',
        message:
          'Command instantiates a COM object which may have execution capabilities',
      }
    }
    // SECURITY：checkTypeLiterals 只能看到 parsed.typeLiterals 中的 [bracket]
    // 语法。`New-Object System.Net.WebClient` 把类型作为字符串参数
    // （StringConstantExpressionAst）传递，而非 TypeExpressionAst，因此 CLM
    // 不会触发。提取 -TypeName（命名、冒号绑定或位置 0）并交给
    // isClmAllowedType。关闭攻击向量 D4。
    let typeName: string | undefined
    for (let i = 0; i < cmd.args.length; i++) {
      const a = cmd.args[i]!
      const lower = a.toLowerCase()
      // -TypeName 缩写：-t 无歧义（New-Object 没有其他 -t* 参数）。
      // 先处理冒号绑定形式：-TypeName:Foo.Bar
      if (lower.startsWith('-t') && lower.includes(':')) {
        const colonIdx = a.indexOf(':')
        const paramPart = lower.slice(0, colonIdx)
        if ('-typename'.startsWith(paramPart)) {
          typeName = a.slice(colonIdx + 1)
          break
        }
      }
      // 空格分隔形式：-TypeName Foo.Bar
      if (
        lower.startsWith('-t') &&
        '-typename'.startsWith(lower) &&
        cmd.args[i + 1] !== undefined
      ) {
        typeName = cmd.args[i + 1]
        break
      }
    }
    // 位置 0 绑定到 -TypeName（NetParameterSet 默认）。命名参数
    // （-Strict、-ArgumentList、-Property、-ComObject）可能出现在位置
    // TypeName 之前，因此跳过它们以找到第一个未被消费的参数。
    if (typeName === undefined) {
      // New-Object 中消费后续值参数的命名参数
      const VALUE_PARAMS = new Set(['-argumentlist', '-comobject', '-property'])
      // Switch 参数（无值参数）
      const SWITCH_PARAMS = new Set(['-strict'])
      for (let i = 0; i < cmd.args.length; i++) {
        const a = cmd.args[i]!
        if (a.startsWith('-')) {
          const lower = a.toLowerCase()
          // 跳过 -TypeName 各变体（上面命名参数循环已处理）
          if (lower.startsWith('-t') && '-typename'.startsWith(lower)) {
            i++ // 跳过值
            continue
          }
          // 冒号绑定形式：-Param:Value（单 token，无需跳过）
          if (lower.includes(':')) continue
          if (SWITCH_PARAMS.has(lower)) continue
          if (VALUE_PARAMS.has(lower)) {
            i++ // 跳过值
            continue
          }
          // 未知参数 —— 保守跳过
          continue
        }
        // 第一个非 dash 参数即位置 TypeName
        typeName = a
        break
      }
    }
    if (typeName !== undefined && !isClmAllowedType(typeName)) {
      return {
        behavior: 'ask',
        message: `New-Object instantiates .NET type '${typeName}' outside the ConstrainedLanguage allowlist`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 DANGEROUS_SCRIPT_BLOCK_CMDLETS 以 -FilePath（或 -LiteralPath）调用
 * 的情形。这会运行一个脚本文件 —— 任意代码执行且树中没有 ScriptBlockAst。
 *
 * checkScriptBlockInjection 仅在 hasScriptBlocks 为 true 时触发。使用
 * -FilePath 时不存在 ScriptBlockAst，因此 DANGEROUS_SCRIPT_BLOCK_CMDLETS
 * 永远不会被查询。本检查补上 -FilePath 向量的缺口。
 *
 * DANGEROUS_SCRIPT_BLOCK_CMDLETS 中接受 -FilePath 的 cmdlet：
 *   Invoke-Command   -FilePath             （icm 别名经 COMMON_ALIASES 解析）
 *   Start-Job        -FilePath, -LiteralPath
 *   Start-ThreadJob  -FilePath
 *   Register-ScheduledJob -FilePath
 * *-PSSession 与 Register-*Event 条目不接受 -FilePath。
 *
 * -f 对四个 cmdlet 的 -FilePath 都无歧义（没有其他 -f* 参数）。
 * -l 对 Start-Job 的 -LiteralPath 无歧义；对其他 cmdlet 是无害空操作
 * （没有可冲突的 -l* 参数）。
 */

function checkDangerousFilePathExecution(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (!FILEPATH_EXECUTION_CMDLETS.has(resolved)) {
      continue
    }
    if (
      psExeHasParamAbbreviation(cmd, '-filepath', '-f') ||
      psExeHasParamAbbreviation(cmd, '-literalpath', '-l')
    ) {
      return {
        behavior: 'ask',
        message: `${cmd.name} -FilePath executes an arbitrary script file`,
      }
    }
    // 位置绑定：`Start-Job script.ps1` 通过 FilePathParameterSet 解析把
    // 位置 0 绑定到 -FilePath（ScriptBlock 参数会改选 ScriptBlockParameterSet）。
    // 与 checkForEachMemberName 同模式：任何非 dash 的 StringConstant 都是
    // 潜在 -FilePath。过度标记（如 `Start-Job -Name foo` 中 `foo` 是
    // StringConstant）属于 fail-safe。
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message: `${cmd.name} with positional string argument binds to -FilePath and executes a script file`,
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 ForEach-Object -MemberName。按字符串名对每个管道对象调用方法 ——
 * 语义上等价于 `| % { $_.Method() }`，但树中没有任何 ScriptBlockAst 或
 * InvokeMemberExpressionAst。
 *
 * PoC：`Get-Process | ForEach-Object -MemberName Kill` → 杀掉所有进程。
 * checkScriptBlockInjection 漏掉它（无 script block）；
 * checkMemberInvocations 漏掉它（无 .Method() 语法）。
 * 别名 `%` 和 `foreach` 经 COMMON_ALIASES 解析。
 */
function checkForEachMemberName(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (resolved !== 'foreach-object') {
      continue
    }
    // ForEach-Object 以 -m 开头的参数只有 -MemberName。-m 无歧义。
    if (psExeHasParamAbbreviation(cmd, '-membername', '-m')) {
      return {
        behavior: 'ask',
        message:
          'ForEach-Object -MemberName invokes methods by string name which cannot be validated',
      }
    }
    // PS7+：`ForEach-Object Kill` 通过 MemberSet 参数集解析把位置字符串参数
    // 绑定到 -MemberName（ScriptBlock 参数会改选 ScriptBlockSet）。扫描全部
    // 参数 —— `-Verbose Kill` 或 `-ErrorAction Stop Kill` 仍会把 Kill 按位置
    // 绑定。任何非 dash 的 StringConstant 都是潜在 -MemberName；过度标记属于
    // fail-safe。
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message:
            'ForEach-Object with positional string argument binds to -MemberName and invokes methods by name',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查危险的 Start-Process 模式。
 *
 * 两个向量：
 * 1. `-Verb RunAs` —— 提权（UAC 弹窗）。
 * 2. 启动 PowerShell 可执行文件 —— 嵌套调用。
 * `Start-Process pwsh -ArgumentList "-e <b64>"` 可绕过
 * checkEncodedCommand/checkPwshCommandOrFile，因为 cmd.name 是
 * `Start-Process` 而非 `pwsh`。`-e` 藏在 -ArgumentList 字符串值内部，
 * 永远不会被当作外层命令的参数解析。与其解析 -ArgumentList 内容
 * （脆弱 —— 它是不透明字符串或数组），不如标记任何目标是 PS 可执行文件的
 * Start-Process：嵌套调用在构造上就无法验证。
 */
function checkStartProcess(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower !== 'start-process' && lower !== 'saps' && lower !== 'start') {
      continue
    }
    // 向量 1：-Verb RunAs（空格或冒号语法）。
    // 空格语法：psExeHasParamAbbreviation 找到 -Verb/-v 后，扫描参数中
    // 是否存在裸 'runas' token。
    if (
      psExeHasParamAbbreviation(cmd, '-Verb', '-v') &&
      cmd.args.some(a => a.toLowerCase() === 'runas')
    ) {
      return {
        behavior: 'ask',
        message: 'Command requests elevated privileges',
      }
    }
    // 冒号语法 —— 两层：
    // (a) 结构化：PR #23554 为冒号绑定的参数增加了 children[]。
    //     children[i] = [{type, text}] 表示绑定的值。检查任何 -v* 前缀参数
    //     是否有 child 的 text 归一化（去除引号/反引号/空白）后为 'runas'。
    //     对正则无法预见的任意引号写法都稳健。
    // (b) 正则回退：用于没有 children[] 的解析输出，或作为纵深防御。
    //     -Verb:'RunAs'、-Verb:"RunAs"、-Verb:`runas 都曾绕过旧的
    //     /...:runas$/ 模式，因为引号/反引号破坏了匹配。
    if (cmd.children) {
      for (let i = 0; i < cmd.args.length; i++) {
        // 匹配参数名前先去反引号（bug #14）：-V`erb:RunAs
        const argClean = cmd.args[i]!.replace(/`/g, '')
        if (!/^[-\u2013\u2014\u2015/]v[a-z]*:/i.test(argClean)) continue
        const kids = cmd.children[i]
        if (!kids) continue
        for (const child of kids) {
          if (child.text.replace(/['"`\s]/g, '').toLowerCase() === 'runas') {
            return {
              behavior: 'ask',
              message: 'Command requests elevated privileges',
            }
          }
        }
      }
    }
    if (
      cmd.args.some(a => {
        // 匹配前去反引号（bug #14 / review nit #2）
        const clean = a.replace(/`/g, '')
        return /^[-\u2013\u2014\u2015/]v[a-z]*:['"` ]*runas['"` ]*$/i.test(
          clean,
        )
      })
    ) {
      return {
        behavior: 'ask',
        message: 'Command requests elevated privileges',
      }
    }
    // 向量 2：Start-Process 的目标是 PowerShell 可执行文件。
    // 目标是第一个位置参数或 -FilePath 后的值。扫描全部参数 —— 出现的任何
    // PS 可执行文件 token 都视为启动目标。已知误报：值为路径的参数
    // （-WorkingDirectory、-RedirectStandard*）其 basename 是 pwsh/powershell
    // 时 —— isPowerShellExecutable 会从路径提取 basename，因此
    // `-WorkingDirectory C:\projects\pwsh` 会触发。接受的取舍：
    // Start-Process 不在 CMDLET_ALLOWLIST（无论如何都会提示），结果是 ask
    // 而非 reject，且正确解析 Start-Process 的参数绑定很脆弱。
    // 去除解析器可能保留的引号。
    for (const arg of cmd.args) {
      const stripped = arg.replace(/^['"]|['"]$/g, '')
      if (isPowerShellExecutable(stripped)) {
        return {
          behavior: 'ask',
          message:
            'Start-Process launches a nested PowerShell process which cannot be validated',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * script block 安全的 cmdlet（过滤/输出类）。
 * 管道给这些 cmdlet 的 script block 只是谓词或投影，不是任意执行。
 */
const SAFE_SCRIPT_BLOCK_CMDLETS = new Set([
  'where-object',
  'sort-object',
  'select-object',
  'group-object',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  // 不含 foreach-object —— 它的 block 是任意脚本，不是谓词。
  // getAllCommands 会递归，因此 block 内部的命令仍会被检查，
  // 但非命令 AST 节点（AssignmentStatementAst 等）对它不可见。
  // 见 powershellPermissions.ts 第 5 步 hasScriptBlocks 守卫。
])

/**
 * 检查 script block 注入模式：script block 出现在可能执行任意代码的
 * 可疑上下文中。
 *
 * 与安全过滤/输出 cmdlet（Where-Object、Sort-Object、Select-Object、
 * Group-Object）配合的 script block 放行。
 * 与危险 cmdlet（Invoke-Command、Invoke-Expression、Start-Job 等）配合的
 * script block 标记。
 */
function checkScriptBlockInjection(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  const security = deriveSecurityFlags(parsed)
  if (!security.hasScriptBlocks) {
    return { behavior: 'passthrough' }
  }

  // 检查解析结果中的所有命令。任一命令落在危险集合中即标记。
  // 若所有带 script block 的命令都在安全集合（或 allowlist）中，则放行。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (DANGEROUS_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command contains script block with dangerous cmdlet that may execute arbitrary code',
      }
    }
  }

  // 检查是否所有命令要么是安全的 script block 消费方，要么不使用 script block
  const allCommandsSafe = getAllCommands(parsed).every(cmd => {
    const lower = cmd.name.toLowerCase()
    // 安全的过滤/输出 cmdlet
    if (SAFE_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return true
    }
    // 解析别名
    const alias = COMMON_ALIASES[lower]
    if (alias && SAFE_SCRIPT_BLOCK_CMDLETS.has(alias.toLowerCase())) {
      return true
    }
    // 存在 script block 时的未知命令 —— 按潜在危险标记
    return false
  })

  if (allCommandsSafe) {
    return { behavior: 'passthrough' }
  }

  return {
    behavior: 'ask',
    message: 'Command contains script block that may execute arbitrary code',
  }
}

/**
 * 纯 AST 检查：检测可隐藏命令执行的子表达式 $()。
 */
function checkSubExpressions(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasSubExpressions) {
    return {
      behavior: 'ask',
      message: 'Command contains subexpressions $()',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 纯 AST 检查：检测内嵌表达式的可展开字符串（双引号），
 * 如 "$env:PATH" 或 "$(dangerous-command)"。它们可在字符串字面量内
 * 隐藏命令执行或变量插值。
 */
function checkExpandableStrings(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasExpandableStrings) {
    return {
      behavior: 'ask',
      message: 'Command contains expandable strings with embedded expressions',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 纯 AST 检查：检测可掩盖参数的 splatting（@variable）。
 */
function checkSplatting(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasSplatting) {
    return {
      behavior: 'ask',
      message: 'Command uses splatting (@variable)',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 纯 AST 检查：检测阻止后续解析的 stop-parsing token（--%）。
 */
function checkStopParsing(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasStopParsing) {
    return {
      behavior: 'ask',
      message: 'Command uses stop-parsing token (--%)',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 纯 AST 检查：检测可访问系统 API 的 .NET 方法调用。
 */
function checkMemberInvocations(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasMemberInvocations) {
    return {
      behavior: 'ask',
      message: 'Command invokes .NET methods',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 纯 AST 检查：不在微软 ConstrainedLanguage allowlist 内的类型字面量。
 * CLM 阻止除约 90 个微软认为对不可信代码安全的基元/特性之外的一切 .NET
 * 类型访问。我们信任该清单作为“安全”边界 —— 边界之外的类型
 * （Reflection.Assembly、IO.Pipes、Diagnostics.Process、
 * InteropServices.Marshal 等）可以访问能击穿权限模型的系统 API。
 *
 * 在 checkMemberInvocations 之后运行：那个检查宽泛标记任何 ::Method /
 * .Method() 调用；本检查是更具体的“哪些类型”信号。两者都会在
 * [Reflection.Assembly]::Load 上触发；CLM 给出更精确的文案。
 * 纯类型转换如 [int]$x 没有成员调用，只会命中本检查。
 */
function checkTypeLiterals(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const t of parsed.typeLiterals ?? []) {
    if (!isClmAllowedType(t)) {
      return {
        behavior: 'ask',
        message: `Command uses .NET type [${t}] outside the ConstrainedLanguage allowlist`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Invoke-Item（别名 ii）用默认处理程序打开文件（Windows 上 ShellExecute，
 * Unix 上 open/xdg-open）。对 .exe/.ps1/.bat/.cmd 而言这就是 RCE。
 * Bug 008：ii 不在任何 blocklist 中；passthrough 提示不解释执行风险。
 * 永远 ask —— 不存在安全变体（即使打开 .txt 也可能调用接受参数的
 * 用户自定义处理程序）。
 */
function checkInvokeItem(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower === 'invoke-item' || lower === 'ii') {
      return {
        behavior: 'ask',
        message:
          'Invoke-Item opens files with the default handler (ShellExecute). On executable files this runs arbitrary code.',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 计划任务持久化原语。Register-ScheduledJob 已被拦截
 * （DANGEROUS_SCRIPT_BLOCK_CMDLETS）；较新的 Register-ScheduledTask cmdlet
 * 和旧的 schtasks.exe /create 没有。这是能跨会话存活且无解释性提示的
 * 持久化手段。
 */
const SCHEDULED_TASK_CMDLETS = new Set([
  'register-scheduledtask',
  'new-scheduledtask',
  'new-scheduledtaskaction',
  'set-scheduledtask',
])

function checkScheduledTask(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (SCHEDULED_TASK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} creates or modifies a scheduled task (persistence primitive)`,
      }
    }
    if (lower === 'schtasks' || lower === 'schtasks.exe') {
      if (
        cmd.args.some(a => {
          const la = a.toLowerCase()
          return (
            la === '/create' ||
            la === '/change' ||
            la === '-create' ||
            la === '-change'
          )
        })
      ) {
        return {
          behavior: 'ask',
          message:
            'schtasks with create/change modifies scheduled tasks (persistence primitive)',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 纯 AST 检查：检测通过 Set-Item/New-Item 等对 env: 作用域的环境变量操纵。
 */
const ENV_WRITE_CMDLETS = new Set([
  'set-item',
  'si',
  'new-item',
  'ni',
  'remove-item',
  'ri',
  'del',
  'rm',
  'rd',
  'rmdir',
  'erase',
  'clear-item',
  'cli',
  'set-content',
  // 不含 'sc' —— 在 PS Core 7+ 上与 sc.exe 冲突，见 COMMON_ALIASES 注释
  'add-content',
  'ac',
])

function checkEnvVarManipulation(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  const envVars = getVariablesByScope(parsed, 'env')
  if (envVars.length === 0) {
    return { behavior: 'passthrough' }
  }
  // 检查是否存在写类 cmdlet
  for (const cmd of getAllCommands(parsed)) {
    if (ENV_WRITE_CMDLETS.has(cmd.name.toLowerCase())) {
      return {
        behavior: 'ask',
        message: 'Command modifies environment variables',
      }
    }
  }
  // 涉及 env 变量的赋值同样标记
  if (deriveSecurityFlags(parsed).hasAssignments && envVars.length > 0) {
    return {
      behavior: 'ask',
      message: 'Command modifies environment variables',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 模块加载 cmdlet 会执行 .psm1 的顶层脚本体（Import-Module），或从任意
 * 仓库下载（Install-Module、Save-Module）。`Import-Module:*` 这样的通配
 * allow 规则会让攻击者提供的 .psm1 以用户权限执行 —— 风险与
 * Invoke-Expression 相同。
 *
 * NEVER_SUGGEST（dangerousCmdlets.ts）从该清单派生，因此 UI 永远不会把
 * 这些 cmdlet 作为通配建议提供，但用户仍可手写 allow 规则。本检查确保
 * 权限引擎独立拦截这些 cmdlet。
 */

function checkModuleLoading(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (MODULE_LOADING_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command loads, installs, or downloads a PowerShell module or script, which can execute arbitrary code',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Set-Alias/New-Alias 可劫持后续命令解析：`Set-Alias Get-Content
 * Invoke-Expression` 之后，任何后续的 `Get-Content $x` 都会执行任意代码。
 * Set-Variable/New-Variable 可污染 `$PSDefaultParameterValues`（例如
 * `Set-Variable PSDefaultParameterValues @{'*:Path'='/etc/passwd'}`），
 * 从而改变后续每个 cmdlet 的行为。两种效应都无法静态验证 —— 需要跟踪会话中
 * 所有未来的命令解析。永远 ask。
 */
const RUNTIME_STATE_CMDLETS = new Set([
  'set-alias',
  'sal',
  'new-alias',
  'nal',
  'set-variable',
  'sv',
  'new-variable',
  'nv',
])

function checkRuntimeStateManipulation(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    // 去掉模块限定符：`Microsoft.PowerShell.Utility\Set-Alias` → `set-alias`
    const raw = cmd.name.toLowerCase()
    const lower = raw.includes('\\')
      ? raw.slice(raw.lastIndexOf('\\') + 1)
      : raw
    if (RUNTIME_STATE_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command creates or modifies an alias or variable that can affect future command resolution',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Invoke-WmiMethod / Invoke-CimMethod 是经 WMI 的 Start-Process 等价物。
 * `Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList "cmd /c ..."`
 * 可生成任意进程，完全绕过 checkStartProcess。不存在可收窄的安全用法 ——
 * -Class 和 -MethodName 接受任意字符串，因此只对 Win32_Process 设卡会漏掉
 * -Class $x 或其他可生成进程的 WMI 类。任何调用都返回 ask。
 * （security finding #34）
 */
const WMI_SPAWN_CMDLETS = new Set([
  'invoke-wmimethod',
  'iwmi',
  'invoke-cimmethod',
])

function checkWmiProcessSpawn(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (WMI_SPAWN_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} can spawn arbitrary processes via WMI/CIM (Win32_Process Create)`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * PowerShell 安全验证主入口。按已知危险模式检查一条 PowerShell 命令。
 *
 * 所有检查均基于 AST。AST 解析失败（parsed.valid === false）时，
 * 各检查都不会命中，返回 'ask' 作为安全默认值。
 *
 * @param _command - 待验证的 PowerShell 命令（未使用，为 API 兼容保留）
 * @param parsed - PowerShell 原生解析器产生的 AST（必需）
 * @returns 指示命令是否安全的安全结果
 */
export function powershellCommandIsSafe(
  _command: string,
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // AST 解析失败时无法判定安全性 —— 交给用户裁决
  if (!parsed.valid) {
    return {
      behavior: 'ask',
      message: 'Could not parse command for security analysis',
    }
  }

  const validators = [
    checkInvokeExpression,
    checkDynamicCommandName,
    checkEncodedCommand,
    checkPwshCommandOrFile,
    checkDownloadCradles,
    checkDownloadUtilities,
    checkAddType,
    checkComObject,
    checkDangerousFilePathExecution,
    checkInvokeItem,
    checkScheduledTask,
    checkForEachMemberName,
    checkStartProcess,
    checkScriptBlockInjection,
    checkSubExpressions,
    checkExpandableStrings,
    checkSplatting,
    checkStopParsing,
    checkMemberInvocations,
    checkTypeLiterals,
    checkEnvVarManipulation,
    checkModuleLoading,
    checkRuntimeStateManipulation,
    checkWmiProcessSpawn,
  ]

  // 三档链按严重度结算,不复用 Claude 的"首个命中即返回":
  // deny 档(下载摇篮/混淆载荷)必须压过 ask——否则摇篮里必然出现的 IEX
  // 会被 checkInvokeExpression 先判成 ask,deny 永远不可达。
  // 同档内仍保持数组顺序,首个命中的 message 即最终文案。
  let firstAsk: PowerShellSecurityResult | null = null
  for (const validator of validators) {
    const result = validator(parsed)
    if (result.behavior === 'deny') {
      return result
    }
    if (result.behavior === 'ask' && firstAsk === null) {
      firstAsk = result
    }
  }
  if (firstAsk !== null) {
    return firstAsk
  }

  // 全部检查通过
  return { behavior: 'passthrough' }
}
