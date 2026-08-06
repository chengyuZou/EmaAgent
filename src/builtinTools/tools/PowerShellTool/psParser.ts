// PowerShell 命令的 AST 解析:起真实 pwsh/powershell 子进程,用 SMA.Language.Parser
// 把命令解析成结构化 JSON,再在 TS 侧变换为安全分析消费的形状。
// 对照 Claude src/utils/powershell/parser.ts 移植;execa 换成 node:child_process。
//
// 为什么不用 JS 模拟 parser:PS 语法边角(四种破折号、反引号转义、模块前缀……)
// 任何模拟都有差异,而差异就是绕过面。让 PowerShell 解析它自己,解析永真。
import { execFile } from 'node:child_process';
import { detectPowerShell } from './powershellDetection.js';
import { memoizeWithLRU } from './memoizeLru.js';

// ── 对外类型:对应 System.Management.Automation.Language 的 AST 类 ──────────────

/** 管道元素类型:CommandBaseAst 的派生类。 */
type PipelineElementType = 'CommandAst' | 'CommandExpressionAst' | 'ParenExpressionAst';

/**
 * 命令元素(参数/表达式)的 AST 节点类型。
 * TS 侧据此推导安全标志,不必再在 PS 里多次 Find-AstNodes。
 */
type CommandElementType =
  | 'ScriptBlock'
  | 'SubExpression'
  | 'ExpandableString'
  | 'MemberInvocation'
  | 'Variable'
  | 'StringConstant'
  | 'Parameter'
  | 'Other';

/**
 * 命令元素的子节点(只下一层)。目前只有 CommandParameterAst 的
 * 冒号绑定参数(-InputObject:$env:SECRET)会填充,消费方靠它区分
 * 绑定值是 Variable 还是 StringConstant,不必再解析文本里的 : 和 $。
 */
export type CommandElementChild = {
  type: CommandElementType;
  text: string;
};

/** 语句类型:StatementAst 的派生类。 */
type StatementType =
  | 'PipelineAst'
  | 'PipelineChainAst'
  | 'AssignmentStatementAst'
  | 'IfStatementAst'
  | 'ForStatementAst'
  | 'ForEachStatementAst'
  | 'WhileStatementAst'
  | 'DoWhileStatementAst'
  | 'DoUntilStatementAst'
  | 'SwitchStatementAst'
  | 'TryStatementAst'
  | 'TrapStatementAst'
  | 'FunctionDefinitionAst'
  | 'DataStatementAst'
  | 'UnknownStatementAst';

/** 管道段中的一次命令调用。 */
export type ParsedCommandElement = {
  /** 命令/cmdlet 名(如 "Get-ChildItem"、"git")。 */
  name: string;
  /** 名字类型:cmdlet、application(exe)、unknown。 */
  nameType: 'cmdlet' | 'application' | 'unknown';
  /** PowerShell parser 给出的 AST 元素类型。 */
  elementType: PipelineElementType;
  /** 全部参数的字符串形式(含 "-Recurse" 这类旗标)。 */
  args: string[];
  /** 该命令元素的完整文本。 */
  text: string;
  /** 每个元素的 AST 节点类型(参数、表达式等)。 */
  elementTypes?: CommandElementType[];
  /**
   * 与 args[] 对齐的子节点(children[i] ↔ args[i] ↔ elementTypes[i+1])。
   * 仅冒号绑定的 Parameter 元素有值。消费方用
   * children[i].some(c => c.type !== 'StringConstant') 代替文本猜测。
   */
  children?: (CommandElementChild[] | undefined)[];
  /** 该命令元素上的重定向(&&/|| 链里的嵌套命令也会带)。 */
  redirections?: ParsedRedirection[];
};

/** 命令中发现的一处重定向。 */
type ParsedRedirection = {
  operator: '>' | '>>' | '2>' | '2>>' | '*>' | '*>>' | '2>&1';
  /** 目标(文件路径或流号)。 */
  target: string;
  /** 是否为 2>&1 这类合并重定向。 */
  isMerging: boolean;
};

/** 一条解析出的语句:管道、赋值、控制流等。 */
type ParsedStatement = {
  statementType: StatementType;
  /** 管道语句的逐段命令。 */
  commands: ParsedCommandElement[];
  /** 该语句上的重定向。 */
  redirections: ParsedRedirection[];
  text: string;
  /**
   * 控制流语句(if/for/foreach/while/try 等)体块内递归发现的全部命令。
   * 用 FindAll 提取任意深度的 CommandAst。
   */
  nestedCommands?: ParsedCommandElement[];
  /**
   * 对整个语句 FindAll 得到的安全相关模式,与语句类型无关。
   * 兜住 elementTypes 漏掉的情形(如赋值里的成员调用、非管道语句的子表达式)。
   */
  securityPatterns?: {
    hasMemberInvocations?: boolean;
    hasSubExpressions?: boolean;
    hasExpandableStrings?: boolean;
    hasScriptBlocks?: boolean;
  };
};

/** 发现的变量引用。path 如 "HOME"、"env:PATH"、"global:x"。 */
type ParsedVariable = {
  path: string;
  /** 是否为 @var 展开(splatting)。 */
  isSplatted: boolean;
};

type ParseError = { message: string; errorId: string };

/** pwsh 返回的完整解析结果。 */
export type ParsedPowerShellCommand = {
  /** 语法层面是否解析成功。 */
  valid: boolean;
  errors: ParseError[];
  /** 顶层语句,按 ; 或换行分隔。 */
  statements: ParsedStatement[];
  variables: ParsedVariable[];
  /** 是否含停止解析令牌 --%。 */
  hasStopParsing: boolean;
  originalCommand: string;
  /**
   * AST 里出现的全部 .NET 类型字面量(TypeExpressionAst + TypeConstraintAst),
   * 取 TypeName.FullName 原文([int] → "int"),不做运行时解析。
   * 供 CLM 白名单检查消费。
   */
  typeLiterals?: string[];
  /**
   * 是否含 using module / using assembly——加载外部代码并执行其顶层脚本体。
   * using 语句是 ScriptBlockAst 上 named block 的兄弟节点,不在其内部,
   * Process-BlockStatements 与任何下游命令遍历都看不到它,必须单独上报。
   */
  hasUsingStatements?: boolean;
  /** 是否含 #Requires 指令(#Requires -Modules 会触发从 PSModulePath 加载模块)。 */
  hasScriptRequirements?: boolean;
};

// ── 解析超时与长度预算 ─────────────────────────────────────────────────────────

// 默认 5s 对交互足够(热身后 pwsh 启动 ~450ms);Windows 上 Defender/AMSI
// 负载可能把连续启动推过 5s。可用环境变量覆盖(测试用)。
const DEFAULT_PARSE_TIMEOUT_MS = 5_000;
function getParseTimeoutMs(): number {
  const env = process.env['EMA_PWSH_PARSE_TIMEOUT_MS'];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PARSE_TIMEOUT_MS;
}

// ── PS1 解析脚本 ───────────────────────────────────────────────────────────────
// 唯一权威副本,不落盘(打包后文件可能不存在)。命令经 Base64 的 $EncodedCommand
// 传入,避免 here-string 注入。
//
// 安全要点——顶层 ParamBlock:ScriptBlockAst.ParamBlock 是 Begin/Process/End 等
// named block 的兄弟节点而非子节点,Process-BlockStatements 永远到不了它;
// param() 默认值表达式和属性参数([ValidateScript({...})])里的命令对所有下游
// 检查不可见。PoC:
//   param($x = (Remove-Item /)); Get-Process   → 只浮出 Get-Process
//   param([ValidateScript({rm /;$true})]$x='t') → rm 不可见,绑定时执行
// 函数级 param() 已被 FunctionDefinitionAst 的 FindAll 覆盖;缺口只在脚本级
// ParamBlock。ParamBlockAst 只有 .Parameters 没有 .Statements,故直接对它
// FindAll。只有确实有内容时才产出语句,避免普通 param($x) 声明制造噪音。
//
// 注释集中在这里(不进脚本内联)——脚本里每个字符都吃 Windows argv 预算。
// 脚本结构:
// - Get-RawCommandElements:提取 CommandAst 元素(type/text/value/
//   expressionType/冒号绑定参数的 children)
// - Get-RawRedirections:提取 FileRedirectionAst 的操作符与目标
// - Get-SecurityPatterns:FindAll 安全标志(hasSubExpressions 经
//   Sub/Array/ParenExpressionAst 等)
// - 类型字面量:为 CLM 白名单检查输出 TypeExpressionAst 名称
// - --% 令牌:PS7 是 MinusMinus kind,PS5.1 是 Generic kind
// - CommandExpressionAst.Redirections 继承自 CommandBaseAst——`1 > /tmp/x`
//   这种语句的 FileRedirectionAst 在逐元素遍历里会漏
// - 嵌套命令:对所有语句类型 FindAll(if/for/foreach/while/switch/try/
//   函数/赋值/PipelineChainAst),跳过循环里已处理的直接管道元素
export const PARSE_SCRIPT_BODY = `
if (-not $EncodedCommand) {
    Write-Output '{"valid":false,"errors":[{"message":"No command provided","errorId":"NoInput"}],"statements":[],"variables":[],"hasStopParsing":false,"originalCommand":""}'
    exit 0
}

$Command = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($EncodedCommand))

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput(
    $Command,
    [ref]$tokens,
    [ref]$parseErrors
)

$allVariables = [System.Collections.ArrayList]::new()

function Get-RawCommandElements {
    param([System.Management.Automation.Language.CommandAst]$CmdAst)
    $elems = [System.Collections.ArrayList]::new()
    foreach ($ce in $CmdAst.CommandElements) {
        $ceData = @{ type = $ce.GetType().Name; text = $ce.Extent.Text }
        if ($ce.PSObject.Properties['Value'] -and $null -ne $ce.Value -and $ce.Value -is [string]) {
            $ceData.value = $ce.Value
        }
        if ($ce -is [System.Management.Automation.Language.CommandExpressionAst]) {
            $ceData.expressionType = $ce.Expression.GetType().Name
        }
        $a=$ce.Argument;if($a){$ceData.children=@(@{type=$a.GetType().Name;text=$a.Extent.Text})}
        [void]$elems.Add($ceData)
    }
    return $elems
}

function Get-RawRedirections {
    param($Redirections)
    $result = [System.Collections.ArrayList]::new()
    foreach ($redir in $Redirections) {
        $redirData = @{ type = $redir.GetType().Name }
        if ($redir -is [System.Management.Automation.Language.FileRedirectionAst]) {
            $redirData.append = [bool]$redir.Append
            $redirData.fromStream = $redir.FromStream.ToString()
            $redirData.locationText = $redir.Location.Extent.Text
        }
        [void]$result.Add($redirData)
    }
    return $result
}

function Get-SecurityPatterns($A) {
    $p = @{}
    foreach ($n in $A.FindAll({ param($x)
        $x -is [System.Management.Automation.Language.MemberExpressionAst] -or
        $x -is [System.Management.Automation.Language.SubExpressionAst] -or
        $x -is [System.Management.Automation.Language.ArrayExpressionAst] -or
        $x -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -or
        $x -is [System.Management.Automation.Language.ScriptBlockExpressionAst] -or
        $x -is [System.Management.Automation.Language.ParenExpressionAst]
    }, $true)) { switch ($n.GetType().Name) {
        'InvokeMemberExpressionAst' { $p.hasMemberInvocations = $true }
        'MemberExpressionAst' { $p.hasMemberInvocations = $true }
        'SubExpressionAst' { $p.hasSubExpressions = $true }
        'ArrayExpressionAst' { $p.hasSubExpressions = $true }
        'ParenExpressionAst' { $p.hasSubExpressions = $true }
        'ExpandableStringExpressionAst' { $p.hasExpandableStrings = $true }
        'ScriptBlockExpressionAst' { $p.hasScriptBlocks = $true }
    }}
    if ($p.Count -gt 0) { return $p }
    return $null
}

$varExprs = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.VariableExpressionAst] }, $true)
foreach ($v in $varExprs) {
    [void]$allVariables.Add(@{
        path = $v.VariablePath.ToString()
        isSplatted = [bool]$v.Splatted
    })
}

$typeLiterals = [System.Collections.ArrayList]::new()
foreach ($t in $ast.FindAll({ param($n)
    $n -is [System.Management.Automation.Language.TypeExpressionAst] -or
    $n -is [System.Management.Automation.Language.TypeConstraintAst]
}, $true)) { [void]$typeLiterals.Add($t.TypeName.FullName) }

$hasStopParsing = $false
$tk = [System.Management.Automation.Language.TokenKind]
foreach ($tok in $tokens) {
    if ($tok.Kind -eq $tk::MinusMinus) { $hasStopParsing = $true; break }
    if ($tok.Kind -eq $tk::Generic -and ($tok.Text -replace '[––—―]','-') -eq '--%') {
        $hasStopParsing = $true; break
    }
}

$statements = [System.Collections.ArrayList]::new()

function Process-BlockStatements {
    param($Block)
    if (-not $Block) { return }

    foreach ($stmt in $Block.Statements) {
        $statement = @{
            type = $stmt.GetType().Name
            text = $stmt.Extent.Text
        }

        if ($stmt -is [System.Management.Automation.Language.PipelineAst]) {
            $elements = [System.Collections.ArrayList]::new()
            foreach ($element in $stmt.PipelineElements) {
                $elemData = @{
                    type = $element.GetType().Name
                    text = $element.Extent.Text
                }

                if ($element -is [System.Management.Automation.Language.CommandAst]) {
                    $elemData.commandElements = @(Get-RawCommandElements -CmdAst $element)
                    $elemData.redirections = @(Get-RawRedirections -Redirections $element.Redirections)
                } elseif ($element -is [System.Management.Automation.Language.CommandExpressionAst]) {
                    $elemData.expressionType = $element.Expression.GetType().Name
                    $elemData.redirections = @(Get-RawRedirections -Redirections $element.Redirections)
                }

                [void]$elements.Add($elemData)
            }
            $statement.elements = @($elements)

            $allNestedCmds = $stmt.FindAll(
                { param($node) $node -is [System.Management.Automation.Language.CommandAst] },
                $true
            )
            $nestedCmds = [System.Collections.ArrayList]::new()
            foreach ($cmd in $allNestedCmds) {
                if ($cmd.Parent -eq $stmt) { continue }
                $nested = @{
                    type = $cmd.GetType().Name
                    text = $cmd.Extent.Text
                    commandElements = @(Get-RawCommandElements -CmdAst $cmd)
                    redirections = @(Get-RawRedirections -Redirections $cmd.Redirections)
                }
                [void]$nestedCmds.Add($nested)
            }
            if ($nestedCmds.Count -gt 0) {
                $statement.nestedCommands = @($nestedCmds)
            }
            $r = $stmt.FindAll({param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst]}, $true)
            if ($r.Count -gt 0) {
                $rr = @(Get-RawRedirections -Redirections $r)
                $statement.redirections = if ($statement.redirections) { @($statement.redirections) + $rr } else { $rr }
            }
        } else {
            $nestedCmdAsts = $stmt.FindAll(
                { param($node) $node -is [System.Management.Automation.Language.CommandAst] },
                $true
            )
            $nested = [System.Collections.ArrayList]::new()
            foreach ($cmd in $nestedCmdAsts) {
                [void]$nested.Add(@{
                    type = 'CommandAst'
                    text = $cmd.Extent.Text
                    commandElements = @(Get-RawCommandElements -CmdAst $cmd)
                    redirections = @(Get-RawRedirections -Redirections $cmd.Redirections)
                })
            }
            if ($nested.Count -gt 0) {
                $statement.nestedCommands = @($nestedCmds)
            }
            $r = $stmt.FindAll({param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst]}, $true)
            if ($r.Count -gt 0) { $statement.redirections = @(Get-RawRedirections -Redirections $r) }
        }

        $sp = Get-SecurityPatterns $stmt
        if ($sp) { $statement.securityPatterns = $sp }

        [void]$statements.Add($statement)
    }

    if ($Block.Traps) {
        foreach ($trap in $Block.Traps) {
            $statement = @{
                type = 'TrapStatementAst'
                text = $trap.Extent.Text
            }
            $nestedCmdAsts = $trap.FindAll(
                { param($node) $node -is [System.Management.Automation.Language.CommandAst] },
                $true
            )
            $nestedCmds = [System.Collections.ArrayList]::new()
            foreach ($cmd in $nestedCmdAsts) {
                $nested = @{
                    type = $cmd.GetType().Name
                    text = $cmd.Extent.Text
                    commandElements = @(Get-RawCommandElements -CmdAst $cmd)
                    redirections = @(Get-RawRedirections -Redirections $cmd.Redirections)
                }
                [void]$nestedCmds.Add($nested)
            }
            if ($nestedCmds.Count -gt 0) { $statement.nestedCommands = @($nestedCmds) }
            $r = $trap.FindAll({param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst]}, $true)
            if ($r.Count -gt 0) { $statement.redirections = @(Get-RawRedirections -Redirections $r) }
            $sp = Get-SecurityPatterns $trap
            if ($sp) { $statement.securityPatterns = $sp }
            [void]$statements.Add($statement)
        }
    }
}

Process-BlockStatements -Block $ast.BeginBlock
Process-BlockStatements -Block $ast.ProcessBlock
Process-BlockStatements -Block $ast.EndBlock
Process-BlockStatements -Block $ast.CleanBlock
Process-BlockStatements -Block $ast.DynamicParamBlock

if ($ast.ParamBlock) {
  $pb = $ast.ParamBlock
  $pn = [System.Collections.ArrayList]::new()
  foreach ($c in $pb.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst]}, $true)) {
    [void]$pn.Add(@{type='CommandAst';text=$c.Extent.Text;commandElements=@(Get-RawCommandElements -CmdAst $c);redirections=@(Get-RawRedirections -Redirections $c.Redirections)})
  }
  $pr = $pb.FindAll({param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst]}, $true)
  $ps = Get-SecurityPatterns $pb
  if ($pn.Count -gt 0 -or $pr.Count -gt 0 -or $ps) {
    $st = @{type='ParamBlockAst';text=$pb.Extent.Text}
    if ($pn.Count -gt 0) { $st.nestedCommands = @($pn) }
    if ($pr.Count -gt 0) { $st.redirections = @(Get-RawRedirections -Redirections $pr) }
    if ($ps) { $st.securityPatterns = $ps }
    [void]$statements.Add($st)
  }
}

$hasUsingStatements = $ast.UsingStatements -and $ast.UsingStatements.Count -gt 0
$hasScriptRequirements = $ast.ScriptRequirements -ne $null

$output = @{
    valid = ($parseErrors.Count -eq 0)
    errors = @($parseErrors | ForEach-Object {
        @{
            message = $_.Message
            errorId = $_.ErrorId
        }
    })
    statements = @($statements)
    variables = @($allVariables)
    hasStopParsing = $hasStopParsing
    originalCommand = $Command
    typeLiterals = @($typeLiterals)
    hasUsingStatements = [bool]$hasUsingStatements
    hasScriptRequirements = [bool]$hasScriptRequirements
}

$output | ConvertTo-Json -Depth 10 -Compress
`;

// ── argv 长度预算 ──────────────────────────────────────────────────────────────
// Windows CreateProcess 命令行上限 32,767 字符。编码链:
//   命令(N 个 UTF-8 字节) → Base64(~4N/3 字符) → $EncodedCommand = '...'\n
//   → 完整脚本(wrapper + PARSE_SCRIPT_BODY) → UTF-16LE(2× 字节)
//   → Base64(4/3× 字符) → -EncodedCommand argv
// 最终 cmdline ≈ argv_overhead + (wrapper + 4N/3 + body) × 8/3
//
// 安全要点:N 是 UTF-8 字节预算,不是 UTF-16 码元预算。门槛必须量
// Buffer.byteLength(command, 'utf8') 而不是 command.length——CJK 字符是
// 1 码元 3 字节,用 .length 会把约 3 倍体积的命令放进去,CreateProcess 失败,
// 解析退化为 valid:false,deny 级检查静默降级成 ask。(Claude finding #36)
//
// 预算从 PARSE_SCRIPT_BODY.length 现算,脚本变长不会把常量拖过期。
// Unix argv 上限通常 2MB+(单参数 ~128KB),不需要这套推导,沿用经验值 4,500;
// 把 Windows 推导套到 Unix 反而退化:1K–4.5K 的复合命令本来能解析并走到
// 子命令 deny 检查,预先拒绝会把用户配置的 deny 规则降级成 ask。
const WINDOWS_ARGV_CAP = 32_767;
// pwsh 路径 + " -NoProfile -NonInteractive -NoLogo -EncodedCommand " + argv 引号。
// 长安装路径(C:\Program Files\PowerShell\7\pwsh.exe)+ 旗标约 95 字符,200 留余量。
const FIXED_ARGV_OVERHEAD = 200;
// 用户命令 base64 外层的 "$EncodedCommand = '" + "'\n" 包装。
const ENCODED_CMD_WRAPPER = `$EncodedCommand = ''\n`.length;
// 两级 base64 的 padding 取整(每级 ≤4 字符)与估算微差。多字节扩张不在这里
// 吸收——门槛量的是真实 UTF-8 字节数。
const SAFETY_MARGIN = 100;
const SCRIPT_CHARS_BUDGET = ((WINDOWS_ARGV_CAP - FIXED_ARGV_OVERHEAD) * 3) / 8;
const CMD_B64_BUDGET =
  SCRIPT_CHARS_BUDGET - PARSE_SCRIPT_BODY.length - ENCODED_CMD_WRAPPER;
/** 单位:UTF-8 字节。比较时必须用 Buffer.byteLength,不是 .length。 */
export const WINDOWS_MAX_COMMAND_LENGTH = Math.max(
  0,
  Math.floor((CMD_B64_BUDGET * 3) / 4) - SAFETY_MARGIN,
);
// Unix 沿用经验值(见上);单位同样是 UTF-8 字节。
const UNIX_MAX_COMMAND_LENGTH = 4_500;
export const MAX_COMMAND_LENGTH =
  process.platform === 'win32' ? WINDOWS_MAX_COMMAND_LENGTH : UNIX_MAX_COMMAND_LENGTH;

// ── 原始 JSON → 对外形状的变换 ─────────────────────────────────────────────────

const INVALID_RESULT_BASE: Omit<ParsedPowerShellCommand, 'errors' | 'originalCommand'> = {
  valid: false,
  statements: [],
  variables: [],
  hasStopParsing: false,
};

function makeInvalidResult(
  command: string,
  message: string,
  errorId: string,
): ParsedPowerShellCommand {
  return {
    ...INVALID_RESULT_BASE,
    errors: [{ message, errorId }],
    originalCommand: command,
  };
}

/** -EncodedCommand 要求 UTF-16LE 的 Base64。 */
function toUtf16LeBase64(text: string): string {
  return Buffer.from(text, 'utf16le').toString('base64');
}

/** 用户命令以 UTF-8 Base64 嵌入变量,防注入。 */
function buildParseScript(command: string): string {
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  return `$EncodedCommand = '${encoded}'\n${PARSE_SCRIPT_BODY}`;
}

/** PS 5.1 的 ConvertTo-Json 会把单元素数组展开成裸对象,这里统一兜回数组。 */
function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// PS1 脚本输出的原始 JSON 形状。
export type RawCommandElement = {
  type: string;
  text: string;
  value?: string;
  expressionType?: string;
  children?: { type: string; text: string }[];
};

export type RawRedirection = {
  type: string;
  append?: boolean;
  fromStream?: string;
  locationText?: string;
};

export type RawPipelineElement = {
  type: string;
  text: string;
  commandElements?: RawCommandElement[];
  redirections?: RawRedirection[];
  expressionType?: string;
};

export type RawStatement = {
  type: string;
  text: string;
  elements?: RawPipelineElement[];
  nestedCommands?: RawPipelineElement[];
  redirections?: RawRedirection[];
  securityPatterns?: {
    hasMemberInvocations?: boolean;
    hasSubExpressions?: boolean;
    hasExpandableStrings?: boolean;
    hasScriptBlocks?: boolean;
  };
};

type RawParsedOutput = {
  valid: boolean;
  errors: { message: string; errorId: string }[];
  statements: RawStatement[];
  variables: { path: string; isSplatted: boolean }[];
  hasStopParsing: boolean;
  originalCommand: string;
  typeLiterals?: string[];
  hasUsingStatements?: boolean;
  hasScriptRequirements?: boolean;
};

export function mapStatementType(rawType: string): StatementType {
  switch (rawType) {
    case 'PipelineAst': return 'PipelineAst';
    case 'PipelineChainAst': return 'PipelineChainAst';
    case 'AssignmentStatementAst': return 'AssignmentStatementAst';
    case 'IfStatementAst': return 'IfStatementAst';
    case 'ForStatementAst': return 'ForStatementAst';
    case 'ForEachStatementAst': return 'ForEachStatementAst';
    case 'WhileStatementAst': return 'WhileStatementAst';
    case 'DoWhileStatementAst': return 'DoWhileStatementAst';
    case 'DoUntilStatementAst': return 'DoUntilStatementAst';
    case 'SwitchStatementAst': return 'SwitchStatementAst';
    case 'TryStatementAst': return 'TryStatementAst';
    case 'TrapStatementAst': return 'TrapStatementAst';
    case 'FunctionDefinitionAst': return 'FunctionDefinitionAst';
    case 'DataStatementAst': return 'DataStatementAst';
    default: return 'UnknownStatementAst';
  }
}

export function mapElementType(rawType: string, expressionType?: string): CommandElementType {
  switch (rawType) {
    case 'ScriptBlockExpressionAst':
      return 'ScriptBlock';
    case 'SubExpressionAst':
    case 'ArrayExpressionAst':
      // 安全:ArrayExpressionAst(@())是 SubExpressionAst 的兄弟而非子类,
      // 两者都会执行任意管道并产生副作用:
      // Get-ChildItem @(Remove-Item ./data) 会在 @() 里跑 Remove-Item。
      // 都映射为 SubExpression,让 hasSubExpressions 触发、只读判定拒绝。
      return 'SubExpression';
    case 'ExpandableStringExpressionAst':
      return 'ExpandableString';
    case 'InvokeMemberExpressionAst':
    case 'MemberExpressionAst':
      return 'MemberInvocation';
    case 'VariableExpressionAst':
      return 'Variable';
    case 'StringConstantExpressionAst':
    case 'ConstantExpressionAst':
      // ConstantExpressionAst 覆盖数字字面量(5、3.14)。权限语义下数字
      // 与字符串字面量同为惰性值;不映射的话 `-Seconds:5` 的
      // children[0].type='Other' 会让"绑定值必须是 StringConstant"的
      // 检查对无害数字参数误报 ask。
      return 'StringConstant';
    case 'CommandParameterAst':
      return 'Parameter';
    case 'ParenExpressionAst':
      return 'SubExpression';
    case 'CommandExpressionAst':
      // 委托给内层表达式类型,SubExpression/ExpandableString/ScriptBlock
      // 等都能兜住,不必维护手工清单;认不出的落到 'Other'。
      if (expressionType) return mapElementType(expressionType);
      return 'Other';
    default:
      return 'Other';
  }
}

/** 命令名分类:Verb-Noun 形为 cmdlet;含 . \ / 的为应用程序;其余 unknown。 */
export function classifyCommandName(name: string): 'cmdlet' | 'application' | 'unknown' {
  if (/^[A-Za-z]+-[A-Za-z][A-Za-z0-9_]*$/.test(name)) return 'cmdlet';
  if (/[.\\/]/.test(name)) return 'application';
  return 'unknown';
}

/** 去掉模块前缀("Microsoft.PowerShell.Utility\\Invoke-Expression" → "Invoke-Expression")。 */
export function stripModulePrefix(name: string): string {
  const idx = name.lastIndexOf('\\');
  if (idx < 0) return name;
  // 不剥文件路径:盘符(C:\...)、UNC(\\server\...)、相对路径(.\、..\)。
  if (
    /^[A-Za-z]:/.test(name)
    || name.startsWith('\\\\')
    || name.startsWith('.\\')
    || name.startsWith('..\\')
  ) {
    return name;
  }
  return name.substring(idx + 1);
}

/** 把原始 CommandAst 管道元素变换为 ParsedCommandElement。 */
export function transformCommandAst(raw: RawPipelineElement): ParsedCommandElement {
  const cmdElements = ensureArray(raw.commandElements);
  let name = '';
  const args: string[] = [];
  const elementTypes: CommandElementType[] = [];
  const children: (CommandElementChild[] | undefined)[] = [];
  let hasChildren = false;

  // 安全:nameType 必须由未剥前缀的原始名字计算。
  // classifyCommandName('scripts\\Get-Process') 含反斜杠应得 'application'
  // (PowerShell 按文件路径解析);剥完前缀变成 'Get-Process' 会被错判成
  // cmdlet,白名单检查会信任它。自动放行路径都用 nameType !== 'application'
  // 设防。剥后的 name 仍用于 deny 规则匹配,这是 fail-safe 方向(deny 多匹配
  // 无害,allow 另有 nameType 闸门)。
  let nameType: 'cmdlet' | 'application' | 'unknown' = 'unknown';
  if (cmdElements.length > 0) {
    const first = cmdElements[0]!;
    // 安全:只有字符串字面量元素且 .value 为 string 时才采用 .value。
    // 数字 ConstantExpressionAst(如 `& 1`)会产生整数 .value,直接拿去
    // stripModulePrefix 会崩;非字符串字面量一律用 .text。
    const isFirstStringLiteral =
      first.type === 'StringConstantExpressionAst'
      || first.type === 'ExpandableStringExpressionAst';
    const rawNameUnstripped =
      isFirstStringLiteral && typeof first.value === 'string' ? first.value : first.text;
    // 安全:剥掉命令名首尾引号。.value 不可用时 .text 保留引号——
    // `& 'Invoke-Expression' 'x'` 会产出 "'Invoke-Expression'"。在源头剥,
    // 下游所有读者(deny 匹配、cmdlet 查表、canonical 化)看到的都是裸名。
    const rawName = rawNameUnstripped.replace(/^['"]|['"]$/g, '');
    // 安全:PS 内置 cmdlet 名全是 ASCII。命令名位置出现非 ASCII 天然可疑:
    // .NET OrdinalIgnoreCase 会把 U+017F(ſ)折成 S、U+0131(ı)折成 I,
    // 而 JS 的 .toLowerCase() 不做这种折叠,下游名字比较会全部漏掉。
    // 强制 'application' 让自动放行的 nameType 闸门拦住。(Claude finding #31)
    if (/[-￿]/.test(rawName)) {
      nameType = 'application';
    } else {
      nameType = classifyCommandName(rawName);
    }
    name = stripModulePrefix(rawName);
    elementTypes.push(mapElementType(first.type, first.expressionType));

    for (let i = 1; i < cmdElements.length; i++) {
      const ce = cmdElements[i]!;
      // 字符串常量用解析后的 .value(剥引号、解反引号转义);参数保留
      // 原始 .text(.value 会丢破折号前缀,'-Path' → 'Path')。
      const isStringLiteral =
        ce.type === 'StringConstantExpressionAst'
        || ce.type === 'ExpandableStringExpressionAst';
      args.push(isStringLiteral && ce.value != null ? ce.value : ce.text);
      elementTypes.push(mapElementType(ce.type, ce.expressionType));
      const rawChildren = ensureArray(ce.children);
      if (rawChildren.length > 0) {
        hasChildren = true;
        children.push(rawChildren.map((c) => ({ type: mapElementType(c.type), text: c.text })));
      } else {
        children.push(undefined);
      }
    }
  }

  const result: ParsedCommandElement = {
    name,
    nameType,
    elementType: 'CommandAst',
    args,
    text: raw.text,
    elementTypes,
    ...(hasChildren ? { children } : {}),
  };

  const rawRedirs = ensureArray(raw.redirections);
  if (rawRedirs.length > 0) {
    result.redirections = rawRedirs.map(transformRedirection);
  }

  return result;
}

/** 变换非 CommandAst 的管道元素(表达式元素)。 */
export function transformExpressionElement(raw: RawPipelineElement): ParsedCommandElement {
  const elementType: PipelineElementType =
    raw.type === 'ParenExpressionAst' ? 'ParenExpressionAst' : 'CommandExpressionAst';
  return {
    name: raw.text,
    nameType: 'unknown',
    elementType,
    args: [],
    text: raw.text,
    elementTypes: [mapElementType(raw.type, raw.expressionType)],
  };
}

export function transformRedirection(raw: RawRedirection): ParsedRedirection {
  if (raw.type === 'MergingRedirectionAst') {
    return { operator: '2>&1', target: '', isMerging: true };
  }
  const append = raw.append ?? false;
  const fromStream = raw.fromStream ?? 'Output';
  let operator: ParsedRedirection['operator'];
  if (append) {
    switch (fromStream) {
      case 'Error': operator = '2>>'; break;
      case 'All': operator = '*>>'; break;
      default: operator = '>>'; break;
    }
  } else {
    switch (fromStream) {
      case 'Error': operator = '2>'; break;
      case 'All': operator = '*>'; break;
      default: operator = '>'; break;
    }
  }
  return { operator, target: raw.locationText ?? '', isMerging: false };
}

/** 变换一条原始语句。 */
export function transformStatement(raw: RawStatement): ParsedStatement {
  const statementType = mapStatementType(raw.type);
  const commands: ParsedCommandElement[] = [];
  const redirections: ParsedRedirection[] = [];

  if (raw.elements) {
    for (const elem of ensureArray(raw.elements)) {
      if (elem.type === 'CommandAst') {
        commands.push(transformCommandAst(elem));
        for (const redir of ensureArray(elem.redirections)) {
          redirections.push(transformRedirection(redir));
        }
      } else {
        commands.push(transformExpressionElement(elem));
        // 安全:CommandExpressionAst 也带 .Redirections(继承自
        // CommandBaseAst)——`1 > /tmp/evil.txt` 是带 FileRedirectionAst 的
        // CommandExpressionAst。不在此提取,getFileRedirections 就会漏,
        // `Get-ChildItem; 1 > /tmp/x` 这种复合命令会只按 Get-ChildItem 被放行。
        for (const redir of ensureArray(elem.redirections)) {
          redirections.push(transformRedirection(redir));
        }
      }
    }
    // PS1 的 PipelineAst 分支还做了深层 FindAll,兜住藏在冒号绑定
    // ParenExpression 参数(-Name:('payload' > file))和哈希表值语句
    // (@{k='payload' > ~/.bashrc})里的重定向。深层 FindAll 会重复发现
    // 直接元素上已捕获的重定向,按 (operator, target) 去重。
    const seen = new Set(redirections.map((r) => `${r.operator} ${r.target}`));
    for (const redir of ensureArray(raw.redirections)) {
      const r = transformRedirection(redir);
      const key = `${r.operator} ${r.target}`;
      if (!seen.has(key)) {
        seen.add(key);
        redirections.push(r);
      }
    }
  } else {
    // 非管道语句:塞一个带全文的合成命令项。
    commands.push({
      name: raw.text,
      nameType: 'unknown',
      elementType: 'CommandExpressionAst',
      args: [],
      text: raw.text,
    });
    // 安全:控制流(if/for/try/&&…‖)里的表达式重定向——
    // if ($x) { 1 > /tmp/evil } 中,字面量 1 及其重定向是
    // CommandExpressionAst,与 CommandAst 是兄弟而非子类,nestedCommands
    // 里根本没有它;不在这里提升,getFileRedirections 就看不到。
    // 直接找 FileRedirectionAst 比找 CommandExpressionAst 再取 .Redirections
    // 更简单也更稳(任何节点类型上的重定向都能兜住)。与 nestedCommands
    // 里已提取的重定向会重复计数,无害——消费方只看 length > 0。
    for (const redir of ensureArray(raw.redirections)) {
      redirections.push(transformRedirection(redir));
    }
  }

  let nestedCommands: ParsedCommandElement[] | undefined;
  const rawNested = ensureArray(raw.nestedCommands);
  if (rawNested.length > 0) {
    nestedCommands = rawNested.map(transformCommandAst);
  }

  const result: ParsedStatement = {
    statementType,
    commands,
    redirections,
    text: raw.text,
    nestedCommands,
  };
  if (raw.securityPatterns) {
    result.securityPatterns = raw.securityPatterns;
  }
  return result;
}

/** 整个原始输出 → ParsedPowerShellCommand。 */
function transformRawOutput(raw: RawParsedOutput): ParsedPowerShellCommand {
  const result: ParsedPowerShellCommand = {
    valid: raw.valid,
    errors: ensureArray(raw.errors),
    statements: ensureArray(raw.statements).map(transformStatement),
    variables: ensureArray(raw.variables),
    hasStopParsing: raw.hasStopParsing,
    originalCommand: raw.originalCommand,
  };
  const tl = ensureArray(raw.typeLiterals);
  if (tl.length > 0) result.typeLiterals = tl;
  if (raw.hasUsingStatements) result.hasUsingStatements = true;
  if (raw.hasScriptRequirements) result.hasScriptRequirements = true;
  return result;
}

// ── 子进程执行 ─────────────────────────────────────────────────────────────────

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * -EncodedCommand 传脚本:避开 stdin 交互模式(-File - 会打印 PS 提示符和
 * ANSI 转义)、命令行转义问题和临时文件。输出是单行压缩 JSON,8MB maxBuffer
 * 足够;windowsHide 防止控制台窗口闪现。
 */
function spawnPwsh(pwshPath: string, args: string[], timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    execFile(
      pwshPath,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, code: 0, timedOut: false });
          return;
        }
        // timeout 触发时 Node 杀进程,error.killed 为 true。
        if ((error as { killed?: boolean }).killed) {
          resolve({ stdout, stderr, code: null, timedOut: true });
          return;
        }
        // 启动失败(ENOENT 等)error.code 是字符串;进程非零退出时是数字。
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') {
          resolve({ stdout, stderr, code, timedOut: false });
          return;
        }
        reject(error);
      },
    );
  });
}

async function parsePowerShellCommandImpl(command: string): Promise<ParsedPowerShellCommand> {
  // 见 MAX_COMMAND_LENGTH 的推导注释:必须量 UTF-8 字节,不是码元。
  const commandBytes = Buffer.byteLength(command, 'utf8');
  if (commandBytes > MAX_COMMAND_LENGTH) {
    return makeInvalidResult(
      command,
      `Command too long for parsing (${commandBytes} bytes). Maximum supported length is ${MAX_COMMAND_LENGTH} bytes.`,
      'CommandTooLong',
    );
  }

  const detection = await detectPowerShell();
  if (!detection.path) {
    return makeInvalidResult(command, 'PowerShell is not available', 'NoPowerShell');
  }

  const script = buildParseScript(command);
  const encodedScript = toUtf16LeBase64(script);
  const args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encodedScript];

  // 超时重试一次:负载高的机器上 pwsh 启动 + .NET JIT + ParseInput 偶尔
  // 超过 5s,单次重试吸收瞬时抖动;两次都超时才报 PwshTimeout。
  const parseTimeoutMs = getParseTimeoutMs();
  let outcome: SpawnOutcome | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      outcome = await spawnPwsh(detection.path, args, parseTimeoutMs);
    } catch (error) {
      return makeInvalidResult(
        command,
        `Failed to spawn PowerShell: ${error instanceof Error ? error.message : error}`,
        'PwshSpawnError',
      );
    }
    if (!outcome.timedOut) break;
  }

  if (outcome!.timedOut) {
    return makeInvalidResult(
      command,
      `pwsh timed out after ${parseTimeoutMs}ms (2 attempts)`,
      'PwshTimeout',
    );
  }
  if (outcome!.code !== 0) {
    return makeInvalidResult(
      command,
      `pwsh exited with code ${outcome!.code}: ${outcome!.stderr}`,
      'PwshError',
    );
  }

  const trimmed = outcome!.stdout.trim();
  if (!trimmed) {
    return makeInvalidResult(command, 'No output from PowerShell parser', 'EmptyOutput');
  }

  try {
    const raw = JSON.parse(trimmed) as RawParsedOutput;
    return transformRawOutput(raw);
  } catch {
    return makeInvalidResult(command, 'Invalid JSON from PowerShell parser', 'InvalidJson');
  }
}

// 瞬时进程故障(可重试),结算后从缓存逐出;确定性失败(命令过长、语法错误)
// 留在缓存里——重试结果相同。
const TRANSIENT_ERROR_IDS = new Set([
  'PwshSpawnError',
  'PwshError',
  'PwshTimeout',
  'EmptyOutput',
  'InvalidJson',
]);

const parsePowerShellCommandCached = memoizeWithLRU(
  (command: string) => {
    const promise = parsePowerShellCommandImpl(command);
    // 瞬时失败结算后逐出以便重试;本次调用方仍拿到同一个缓存 Promise,
    // 并发调用方共享同一次解析。
    void promise.then((result) => {
      if (!result.valid && TRANSIENT_ERROR_IDS.has(result.errors[0]?.errorId ?? '')) {
        parsePowerShellCommandCached.cache.delete(command);
      }
    });
    return promise;
  },
  (command: string) => command,
  256,
);

/** 解析 PowerShell 命令(经真实 pwsh 子进程 + LRU 缓存)。失败一律 valid:false,fail-closed。 */
export { parsePowerShellCommandCached as parsePowerShellCommand };

// ── 分析辅助:从解析结构派生的查询 ───────────────────────────────────────────────

/** 从 AST 派生的安全标志。 */
type SecurityFlags = {
  /** 含 $(...) 子表达式。 */
  hasSubExpressions: boolean;
  /** 含 { ... } 脚本块表达式。 */
  hasScriptBlocks: boolean;
  /** 含 @variable 展开。 */
  hasSplatting: boolean;
  /** 含内嵌表达式的可展开字符串("...$()...")。 */
  hasExpandableStrings: boolean;
  /** 含 .NET 方法调用([Type]::Method 或 $obj.Method())。 */
  hasMemberInvocations: boolean;
  /** 含变量赋值($x = ...)。 */
  hasAssignments: boolean;
  /** 含停止解析令牌 --%。 */
  hasStopParsing: boolean;
};

/**
 * 常见别名 → 规范 cmdlet 名。用 Object.create(null) 防原型链污染:
 * 攻击者构造的命令名 'constructor'、'__proto__' 必须拿到 undefined,
 * 而不是 Object.prototype 上的继承属性。
 *
 * 刻意不收录的别名:sc/sort/curl/wget 在 PS Core 6+ 与同名原生 exe 冲突
 * (sc.exe、sort.exe……)。我们先解析别名再判安全,如果把 sort 映射成
 * Sort-Object 而实际跑的是 sort.exe,就会把错误的程序自动放行。
 * 宁可不写全名时落到 ask,也不收录有二义的别名。
 */
export const COMMON_ALIASES: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    // 目录
    ls: 'Get-ChildItem', dir: 'Get-ChildItem', gci: 'Get-ChildItem',
    // 内容
    cat: 'Get-Content', type: 'Get-Content', gc: 'Get-Content',
    // 导航
    cd: 'Set-Location', sl: 'Set-Location', chdir: 'Set-Location',
    pushd: 'Push-Location', popd: 'Pop-Location', pwd: 'Get-Location', gl: 'Get-Location',
    // 项目
    gi: 'Get-Item', gp: 'Get-ItemProperty', ni: 'New-Item', mkdir: 'New-Item',
    // md 是 mkdir 的内置别名;canonical 化是单跳(不做 md→mkdir→New-Item 链),
    // 缺了这条 md /etc/x 会漏判而 mkdir /etc/x 能抓到。
    md: 'New-Item',
    ri: 'Remove-Item', del: 'Remove-Item', rd: 'Remove-Item', rmdir: 'Remove-Item',
    rm: 'Remove-Item', erase: 'Remove-Item',
    mi: 'Move-Item', mv: 'Move-Item', move: 'Move-Item',
    ci: 'Copy-Item', cp: 'Copy-Item', copy: 'Copy-Item', cpi: 'Copy-Item',
    si: 'Set-Item', rni: 'Rename-Item', ren: 'Rename-Item',
    // 进程
    ps: 'Get-Process', gps: 'Get-Process', kill: 'Stop-Process', spps: 'Stop-Process',
    start: 'Start-Process', saps: 'Start-Process', sajb: 'Start-Job', ipmo: 'Import-Module',
    // 输出
    echo: 'Write-Output', write: 'Write-Output', sleep: 'Start-Sleep',
    // 帮助
    help: 'Get-Help', man: 'Get-Help', gcm: 'Get-Command',
    // 服务
    gsv: 'Get-Service',
    // 变量
    gv: 'Get-Variable', sv: 'Set-Variable',
    // 历史
    h: 'Get-History', history: 'Get-History',
    // 调用
    iex: 'Invoke-Expression', iwr: 'Invoke-WebRequest', irm: 'Invoke-RestMethod',
    icm: 'Invoke-Command', ii: 'Invoke-Item',
    // PSSession——远程代码执行面
    nsn: 'New-PSSession', etsn: 'Enter-PSSession', exsn: 'Exit-PSSession',
    gsn: 'Get-PSSession', rsn: 'Remove-PSSession',
    // 杂项
    cls: 'Clear-Host', clear: 'Clear-Host',
    select: 'Select-Object', where: 'Where-Object', foreach: 'ForEach-Object',
    '%': 'ForEach-Object', '?': 'Where-Object',
    measure: 'Measure-Object',
    ft: 'Format-Table', fl: 'Format-List', fw: 'Format-Wide',
    oh: 'Out-Host', ogv: 'Out-GridView',
    ac: 'Add-Content', clc: 'Clear-Content',
    // tee-object/export-csv 不在自动放行集合里,不存在原生 exe 冲突问题;
    // Linux PS Core 上 `tee` 跑的是 /usr/bin/tee,同样写位置参数文件,语义一致。
    tee: 'Tee-Object', epcsv: 'Export-Csv',
    sp: 'Set-ItemProperty', rp: 'Remove-ItemProperty', cli: 'Clear-Item',
    epal: 'Export-Alias',
    // 文本搜索
    sls: 'Select-String',
  },
);

const DIRECTORY_CHANGE_CMDLETS = new Set(['set-location', 'push-location', 'pop-location']);
const DIRECTORY_CHANGE_ALIASES = new Set(['cd', 'sl', 'chdir', 'pushd', 'popd']);

/** 全部语句、管道段与嵌套命令的命令名(小写)。 */
export function getAllCommandNames(parsed: ParsedPowerShellCommand): string[] {
  const names: string[] = [];
  for (const statement of parsed.statements) {
    for (const cmd of statement.commands) names.push(cmd.name.toLowerCase());
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) names.push(cmd.name.toLowerCase());
    }
  }
  return names;
}

/** 全部管道段拍平成命令列表,供逐段独立检查。 */
export function getAllCommands(parsed: ParsedPowerShellCommand): ParsedCommandElement[] {
  const commands: ParsedCommandElement[] = [];
  for (const statement of parsed.statements) {
    for (const cmd of statement.commands) commands.push(cmd);
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) commands.push(cmd);
    }
  }
  return commands;
}

/** 全部语句上的重定向(含 && / || 链里嵌套命令的)。 */
export function getAllRedirections(parsed: ParsedPowerShellCommand): ParsedRedirection[] {
  const redirections: ParsedRedirection[] = [];
  for (const statement of parsed.statements) {
    for (const redir of statement.redirections) redirections.push(redir);
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) {
        if (cmd.redirections) {
          for (const redir of cmd.redirections) redirections.push(redir);
        }
      }
    }
  }
  return redirections;
}

/** 按作用域过滤变量(如 'env' 匹配 "env:PATH")。 */
export function getVariablesByScope(
  parsed: ParsedPowerShellCommand,
  scope: string,
): ParsedVariable[] {
  const prefix = scope.toLowerCase() + ':';
  return parsed.variables.filter((v) => v.path.toLowerCase().startsWith(prefix));
}

/** 是否出现指定命令(大小写不敏感,含别名互判:别名↔规范名双向命中)。 */
export function hasCommandNamed(parsed: ParsedPowerShellCommand, name: string): boolean {
  const lowerName = name.toLowerCase();
  const canonicalFromAlias = COMMON_ALIASES[lowerName]?.toLowerCase();
  for (const cmdName of getAllCommandNames(parsed)) {
    if (cmdName === lowerName) return true;
    const canonical = COMMON_ALIASES[cmdName]?.toLowerCase();
    if (canonical === lowerName) return true;
    if (canonicalFromAlias && cmdName === canonicalFromAlias) return true;
    if (canonical && canonicalFromAlias && canonical === canonicalFromAlias) return true;
  }
  return false;
}

/** 是否含切目录命令(Set-Location/cd/pushd 等)。 */
export function hasDirectoryChange(parsed: ParsedPowerShellCommand): boolean {
  for (const cmdName of getAllCommandNames(parsed)) {
    if (DIRECTORY_CHANGE_CMDLETS.has(cmdName) || DIRECTORY_CHANGE_ALIASES.has(cmdName)) {
      return true;
    }
  }
  return false;
}

/** 是否为单条简单命令(无管道、无分号、无嵌套)。 */
export function isSingleCommand(parsed: ParsedPowerShellCommand): boolean {
  const stmt = parsed.statements[0];
  return (
    parsed.statements.length === 1
    && stmt !== undefined
    && stmt.commands.length === 1
    && (!stmt.nestedCommands || stmt.nestedCommands.length === 0)
  );
}

/** 某命令是否带指定参数/旗标(大小写不敏感)。 */
export function commandHasArg(command: ParsedCommandElement, arg: string): boolean {
  const lowerArg = arg.toLowerCase();
  return command.args.some((a) => a.toLowerCase() === lowerArg);
}

/**
 * PS tokenizer 接受的参数前缀字符:ASCII 连字符、en-dash、em-dash、
 * horizontal bar 共四种(SpecialCharacters.IsDash)。tokenizer 级,对全部
 * cmdlet 参数生效;/ 只是 powershell.exe 5.1 argv 解析的怪癖,不在此列。
 * Extent.Text 保留原始字符,transformCommandAst 对参数用 ce.text,原样到达。
 */
export const PS_TOKENIZER_DASH_CHARS = new Set(['-', '–', '—', '―']);

/**
 * 判断参数是否为 PS 旗标。有 elementType 时以 AST 为准('Parameter' 即真,
 * 与用户敲的是哪种破折号无关;带引号的 "-Path" 是 StringConstant 不是参数);
 * 没有 elementType 时退回首字符检查。
 */
export function isPowerShellParameter(arg: string, elementType?: CommandElementType): boolean {
  if (elementType !== undefined) return elementType === 'Parameter';
  return arg.length > 0 && PS_TOKENIZER_DASH_CHARS.has(arg[0]!);
}

/**
 * 是否有参数是某参数的"无歧义缩写"。PS 允许参数缩写,前缀无歧义即可:
 * fullParam '-encodedcommand' 配 minPrefix '-en' 能匹配 '-en'、'-enc'、'-enco'……
 */
export function commandHasArgAbbreviation(
  command: ParsedCommandElement,
  fullParam: string,
  minPrefix: string,
): boolean {
  const lowerFull = fullParam.toLowerCase();
  const lowerMin = minPrefix.toLowerCase();
  return command.args.some((a) => {
    // 剥冒号绑定值(-en:base64 → -en)。
    const colonIndex = a.indexOf(':', 1);
    const paramPart = colonIndex > 0 ? a.slice(0, colonIndex) : a;
    // 剥反引号——PS 把 -Member`Name 解析成 -MemberName,但 Extent.Text 保留反引号。
    const lower = paramPart.replace(/`/g, '').toLowerCase();
    return (
      lower.startsWith(lowerMin)
      && lowerFull.startsWith(lower)
      && lower.length <= lowerFull.length
    );
  });
}

/** 按语句给出管道段,供逐段权限检查。 */
export function getPipelineSegments(parsed: ParsedPowerShellCommand): ParsedStatement[] {
  return parsed.statements;
}

/**
 * 重定向目标是否为 $null 自动变量。`> $null` 等价 /dev/null,不是文件写。
 * $null 不可重新赋值,当 no-op 汇安全;${null} 是同一变量的花括号写法。
 * 花括号内带空格(${ null })是另一个变量,不能用正则放宽。
 */
export function isNullRedirectionTarget(target: string): boolean {
  const t = target.trim().toLowerCase();
  return t === '$null' || t === '${null}';
}

/** 写文件的重定向(排除合并重定向与 $null 汇)。 */
export function getFileRedirections(parsed: ParsedPowerShellCommand): ParsedRedirection[] {
  return getAllRedirections(parsed).filter(
    (r) => !r.isMerging && !isNullRedirectionTarget(r.target),
  );
}

/**
 * 从解析结构派生安全标志。替代早期"在 PS 里多次 Find-AstNodes"的做法:
 * PS1 脚本给每个元素打上 AST 节点类型,这里只走路径标注。
 */
export function deriveSecurityFlags(parsed: ParsedPowerShellCommand): SecurityFlags {
  const flags: SecurityFlags = {
    hasSubExpressions: false,
    hasScriptBlocks: false,
    hasSplatting: false,
    hasExpandableStrings: false,
    hasMemberInvocations: false,
    hasAssignments: false,
    hasStopParsing: parsed.hasStopParsing,
  };

  function checkElements(cmd: ParsedCommandElement): void {
    if (!cmd.elementTypes) return;
    for (const et of cmd.elementTypes) {
      switch (et) {
        case 'ScriptBlock': flags.hasScriptBlocks = true; break;
        case 'SubExpression': flags.hasSubExpressions = true; break;
        case 'ExpandableString': flags.hasExpandableStrings = true; break;
        case 'MemberInvocation': flags.hasMemberInvocations = true; break;
      }
    }
  }

  for (const stmt of parsed.statements) {
    if (stmt.statementType === 'AssignmentStatementAst') flags.hasAssignments = true;
    for (const cmd of stmt.commands) checkElements(cmd);
    if (stmt.nestedCommands) {
      for (const cmd of stmt.nestedCommands) checkElements(cmd);
    }
    // securityPatterns 是双保险:兜住 elementTypes 漏掉的模式(赋值里的
    // 成员调用、非管道语句的子表达式)。
    if (stmt.securityPatterns) {
      if (stmt.securityPatterns.hasMemberInvocations) flags.hasMemberInvocations = true;
      if (stmt.securityPatterns.hasSubExpressions) flags.hasSubExpressions = true;
      if (stmt.securityPatterns.hasExpandableStrings) flags.hasExpandableStrings = true;
      if (stmt.securityPatterns.hasScriptBlocks) flags.hasScriptBlocks = true;
    }
  }

  for (const v of parsed.variables) {
    if (v.isSplatted) {
      flags.hasSplatting = true;
      break;
    }
  }

  return flags;
}
