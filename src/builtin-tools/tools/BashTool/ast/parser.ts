/**
 * bashParser.ts 的薄封装：解析入口 + 安全哨兵。
 *
 * 解析器薄封装：
 * - 去掉平台相关的 feature gate
 * - 去掉遥测
 * - 保留 `PARSE_ABORTED` 哨兵及 fail-closed 语义（安全关键）
 *
 * 安全语义（必须保持）：
 * `PARSE_ABORTED` 表示"解析器已加载并尝试解析，但中止了"（超时/节点预算/
 * 异常），与 `null`（未加载/空/超长）不同。对抗性输入可在 MAX_COMMAND_LENGTH
 * 内触发中止：`(( a[0][0]... ))` 约 2800 个下标即可命中超时。调用方必须把
 * 中止视为 fail-closed（too-complex → 询问），绝不能路由到 legacy 路径。
 */

import {
  ensureParserInitialized,
  getParserModule,
  type TsNode,
} from './bashParser.js'

export type Node = TsNode

export interface ParsedCommandData {
  rootNode: Node
  envVars: string[]
  commandNode: Node | null
  originalCommand: string
}

/**
 * 命令长度上限（10000），解析器在该范围内经过 golden corpus 验证；
 * 超过返回 null（parse-unavailable）→ 调用方 fail-closed。
 * 注：我们的 BashTool schema 允许 30000 字符，超过 10000 的命令会走
 * "无法静态分析"的高风险询问路径，不会静默放行。
 */
const MAX_COMMAND_LENGTH = 10000
const DECLARATION_COMMANDS = new Set([
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
  'unset',
  'unsetenv',
])
const ARGUMENT_TYPES = new Set(['word', 'string', 'raw_string', 'number'])
const SUBSTITUTION_TYPES = new Set([
  'command_substitution',
  'process_substitution',
])
const COMMAND_TYPES = new Set(['command', 'declaration_command'])

/** 兼容入口：纯 TS 解析器无需异步初始化（bashParser 内是 no-op）。 */
export async function ensureInitialized(): Promise<void> {
  await ensureParserInitialized()
}

/**
 * 完整解析（含 findCommandNode/extractEnvVars）。
 * 返回 null 表示：空 / 超长 / 解析器不可用 / 解析异常。
 */
export async function parseCommand(
  command: string,
): Promise<ParsedCommandData | null> {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null

  await ensureParserInitialized()
  const mod = getParserModule()
  if (!mod) return null

  try {
    const rootNode = mod.parse(command)
    if (!rootNode) return null

    const commandNode = findCommandNode(rootNode, null)
    const envVars = extractEnvVars(commandNode)

    return { rootNode, envVars, commandNode, originalCommand: command }
  } catch {
    return null
  }
}

/**
 * 安全哨兵："解析器已加载并尝试解析，但中止了"（超时/节点预算/异常）。
 * 与 `null`（模块未加载）区分。对抗性输入可在 MAX_COMMAND_LENGTH 内触发
 * 中止。调用方必须把此哨兵视为 fail-closed（too-complex），绝不能路由
 * 到 legacy 路径。
 */
export const PARSE_ABORTED = Symbol('parse-aborted')

/**
 * 原始解析——跳过 findCommandNode/extractEnvVars（ast.ts 的安全遍历器
 * 不使用它们），每条 bash 命令省一次树遍历。
 *
 * 返回：
 *   - Node：解析成功
 *   - null：模块未加载 / 空 / 超长
 *   - PARSE_ABORTED：模块已加载但解析失败（超时/异常）
 */
export async function parseCommandRaw(
  command: string,
): Promise<Node | null | typeof PARSE_ABORTED> {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null

  await ensureParserInitialized()
  const mod = getParserModule()
  if (!mod) return null
  try {
    const result = mod.parse(command)
    // 安全：模块已加载；这里的 null = bashParser.ts 中的超时/节点预算中止
    //（PARSE_TIMEOUT_MS=50, MAX_NODES=50_000）。
    // 旧实现曾折叠为 `return null` → parse-unavailable → legacy 路径，
    // 而 legacy 路径缺少 EVAL_LIKE_BUILTINS——`trap`、`enable`、`hash`
    // 曾因此泄漏。必须返回 PARSE_ABORTED 以 fail-closed。
    if (result === null) {
      return PARSE_ABORTED
    }
    return result
  } catch {
    return PARSE_ABORTED
  }
}

function findCommandNode(node: Node, parent: Node | null): Node | null {
  const { type, children } = node

  if (COMMAND_TYPES.has(type)) return node

  // 变量赋值后跟命令
  if (type === 'variable_assignment' && parent) {
    return (
      parent.children.find(
        c => COMMAND_TYPES.has(c.type) && c.startIndex > node.startIndex,
      ) ?? null
    )
  }

  // 管道：递归进第一个子节点（可能是 redirected_statement）
  if (type === 'pipeline') {
    for (const child of children) {
      const result = findCommandNode(child, node)
      if (result) return result
    }
    return null
  }

  // 重定向语句：在内部找命令
  if (type === 'redirected_statement') {
    return children.find(c => COMMAND_TYPES.has(c.type)) ?? null
  }

  // 递归搜索
  for (const child of children) {
    const result = findCommandNode(child, node)
    if (result) return result
  }

  return null
}

function extractEnvVars(commandNode: Node | null): string[] {
  if (!commandNode || commandNode.type !== 'command') return []

  const envVars: string[] = []
  for (const child of commandNode.children) {
    if (child.type === 'variable_assignment') {
      envVars.push(child.text)
    } else if (child.type === 'command_name' || child.type === 'word') {
      break
    }
  }
  return envVars
}

export function extractCommandArguments(commandNode: Node): string[] {
  // 声明类命令
  if (commandNode.type === 'declaration_command') {
    const firstChild = commandNode.children[0]
    return firstChild && DECLARATION_COMMANDS.has(firstChild.text)
      ? [firstChild.text]
      : []
  }

  const args: string[] = []
  let foundCommandName = false

  for (const child of commandNode.children) {
    if (child.type === 'variable_assignment') continue

    // 命令名
    if (
      child.type === 'command_name' ||
      (!foundCommandName && child.type === 'word')
    ) {
      foundCommandName = true
      args.push(child.text)
      continue
    }

    // 参数
    if (ARGUMENT_TYPES.has(child.type)) {
      args.push(stripQuotes(child.text))
    } else if (SUBSTITUTION_TYPES.has(child.type)) {
      break
    }
  }
  return args
}

function stripQuotes(text: string): string {
  return text.length >= 2 &&
    ((text[0] === '"' && text.at(-1) === '"') ||
      (text[0] === "'" && text.at(-1) === "'"))
    ? text.slice(1, -1)
    : text
}
