// PowerShell Constrained Language Mode(CLM)允许类型表。
// 对照 Claude packages/builtin-tools/src/tools/PowerShellTool/clmTypes.ts 逐行移植。
//
// 微软 CLM 在 AppLocker/WDAC 系统锁定下把 PS 的 .NET 类型使用限制在这份
// 允许清单内;不在集合中的任何类型都被视为对不可信代码执行不安全。
//
// 我们反向使用它:类型字面量不在集合内 → ask。一个规范化检查替代逐一枚举
// 危险类型(命名管道、反射、进程启动、P/Invoke 封送……)。清单由微软维护。
//
// 来源: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes
//
// 规范化:条目一律小写存储;短名与全名并存(PS 在运行时才把 [int] 这类
// 类型加速器解析为 System.Int32;我们匹配的是 AST 发出的字面文本)。
export const CLM_ALLOWED_TYPES: ReadonlySet<string> = new Set(
  [
    // 类型加速器(AST TypeName.Name 中出现的短名)
    // SECURITY:'adsi' 与 'adsisearcher' 已移除。两者都是 Active Directory
    // Service Interface 类型,类型转换时会执行网络绑定:
    //   [adsi]'LDAP://evil.com/...' → 连接 LDAP 服务器
    //   [adsisearcher]'(objectClass=user)' → 绑定 AD 并查询
    // 微软 CLM 放行它们是因为 CLM 面向可信域内的 Windows 管理员;
    // 我们拦截它们是因为目标地址未经验证。
    'alias',
    'allowemptycollection',
    'allowemptystring',
    'allownull',
    'argumentcompleter',
    'argumentcompletions',
    'array',
    'bigint',
    'bool',
    'byte',
    'char',
    'cimclass',
    'cimconverter',
    'ciminstance',
    // 'cimsession' 已移除——见下方 wmi/adsi 注释
    'cimtype',
    'cmdletbinding',
    'cultureinfo',
    'datetime',
    'decimal',
    'double',
    'dsclocalconfigurationmanager',
    'dscproperty',
    'dscresource',
    'experimentaction',
    'experimental',
    'experimentalfeature',
    'float',
    'guid',
    'hashtable',
    'int',
    'int16',
    'int32',
    'int64',
    'ipaddress',
    'ipendpoint',
    'long',
    'mailaddress',
    'norunspaceaffinity',
    'nullstring',
    'objectsecurity',
    'ordered',
    'outputtype',
    'parameter',
    'physicaladdress',
    'pscredential',
    'pscustomobject',
    'psdefaultvalue',
    'pslistmodifier',
    'psobject',
    'psprimitivedictionary',
    'pstypenameattribute',
    'ref',
    'regex',
    'sbyte',
    'securestring',
    'semver',
    'short',
    'single',
    'string',
    'supportswildcards',
    'switch',
    'timespan',
    'uint',
    'uint16',
    'uint32',
    'uint64',
    'ulong',
    'uri',
    'ushort',
    'validatecount',
    'validatedrive',
    'validatelength',
    'validatenotnull',
    'validatenotnullorempty',
    'validatenotnullorwhitespace',
    'validatepattern',
    'validaterange',
    'validatescript',
    'validateset',
    'validatetrusteddata',
    'validateuserdrive',
    'version',
    'void',
    'wildcardpattern',
    // SECURITY:'wmi'、'wmiclass'、'wmisearcher'、'cimsession' 已移除。
    // WMI 类型转换会执行 WMI 查询,可指向远程计算机(网络请求)并访问
    // Win32_Process 等危险类。cimsession 会创建 CIM 会话(到远程主机的
    // 网络连接)。
    //   [wmi]'\\evil-host\root\cimv2:Win32_Process.Handle="1"' → 远程 WMI
    //   [wmisearcher]'SELECT * FROM Win32_Process' → 执行 WQL 查询
    // 移除理由同上方 adsi/adsisearcher。
    'x500distinguishedname',
    'x509certificate',
    'xml',
    // 解析到 System.* 的加速器全名(AST 两种形态都可能发出)
    'system.array',
    'system.boolean',
    'system.byte',
    'system.char',
    'system.datetime',
    'system.decimal',
    'system.double',
    'system.guid',
    'system.int16',
    'system.int32',
    'system.int64',
    'system.numerics.biginteger',
    'system.sbyte',
    'system.single',
    'system.string',
    'system.timespan',
    'system.uint16',
    'system.uint32',
    'system.uint64',
    'system.uri',
    'system.version',
    'system.void',
    'system.collections.hashtable',
    'system.text.regularexpressions.regex',
    'system.globalization.cultureinfo',
    'system.net.ipaddress',
    'system.net.ipendpoint',
    'system.net.mail.mailaddress',
    'system.net.networkinformation.physicaladdress',
    'system.security.securestring',
    'system.security.cryptography.x509certificates.x509certificate',
    'system.security.cryptography.x509certificates.x500distinguishedname',
    'system.xml.xmldocument',
    // System.Management.Automation.* —— PS 专属加速器的全限定名等价物
    'system.management.automation.pscredential',
    'system.management.automation.pscustomobject',
    'system.management.automation.pslistmodifier',
    'system.management.automation.psobject',
    'system.management.automation.psprimitivedictionary',
    'system.management.automation.psreference',
    'system.management.automation.semanticversion',
    'system.management.automation.switchparameter',
    'system.management.automation.wildcardpattern',
    'system.management.automation.language.nullstring',
    // Microsoft.Management.Infrastructure.* —— CIM 加速器的全限定名等价物
    // SECURITY:cimsession 全限定名已移除——与短名相同的网络绑定风险
    // (创建到远程主机的 CIM 会话)。
    'microsoft.management.infrastructure.cimclass',
    'microsoft.management.infrastructure.cimconverter',
    'microsoft.management.infrastructure.ciminstance',
    'microsoft.management.infrastructure.cimtype',
    // 其余短名加速器的全限定名等价物
    // SECURITY:DirectoryEntry/DirectorySearcher/ManagementObject/
    // ManagementClass/ManagementObjectSearcher 全限定名已移除——与短名
    // adsi/adsisearcher/wmi/wmiclass/wmisearcher 相同的网络绑定风险
    // (LDAP 绑定、远程 WMI)。见上方短名移除注释。
    'system.collections.specialized.ordereddictionary',
    'system.security.accesscontrol.objectsecurity',
    // 允许类型的数组也允许(如 [string[]])
    // normalizeTypeName 查表前会剥掉 [],所以存基名
    'object',
    'system.object',
    // ModuleSpecification —— 全限定名
    'microsoft.powershell.commands.modulespecification',
  ].map((t) => t.toLowerCase()),
);

/**
 * 规范化来自 AST TypeName.FullName 或 TypeName.Name 的类型名。
 * 处理数组后缀([])与泛型括号。
 */
export function normalizeTypeName(name: string): string {
  // 去数组后缀:"String[]" → "string"(允许类型的数组也允许)
  // 去泛型参数:"List[int]" → "list"(保守——即使类型参数安全,
  // 泛型外壳本身也可能不安全,所以检查外层类型)
  return name
    .toLowerCase()
    .replace(/\[\]$/, '')
    .replace(/\[.*\]$/, '')
    .trim();
}

/**
 * typeName(来自 AST)是否在微软 CLM 允许清单内。
 * 不在集合内的类型触发 ask——它们访问的正是 CLM 要拦截的系统 API。
 */
export function isClmAllowedType(typeName: string): boolean {
  return CLM_ALLOWED_TYPES.has(normalizeTypeName(typeName));
}
