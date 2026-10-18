import {
  ensureParserInitialized,
  getParserModule,
  type TsNode,
} from './bashParser.js';

export type Node = TsNode;

// 静态解析只接受 10,000 字符; 更长命令不能按解析出的子命令规则自动放行.
const MAX_COMMAND_LENGTH = 10_000;

/** 已尝试解析但超时, 超出节点预算或抛错. 调用方不能把它当作解析成功. */
export const PARSE_ABORTED = Symbol('parse-aborted');

/**
 * 返回 AST, 或用 null 表示空输入, 超长输入及解析器不可用.
 * PARSE_ABORTED 与 null 都不能作为按子命令自动放行的依据.
 */
export async function parseCommandRaw(
  command: string,
): Promise<Node | null | typeof PARSE_ABORTED> {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null;

  await ensureParserInitialized();
  const mod = getParserModule();
  if (!mod) return null;
  try {
    const result = mod.parse(command);
    return result === null ? PARSE_ABORTED : result;
  } catch {
    return PARSE_ABORTED;
  }
}
