// 'Tool(content)' 规则字符串与 PermissionRuleValue 的双向转换（转义敏感）。
// 整文件照抄 Claude utils/permissions/permissionRuleParser.ts（去掉 legacy 别名表）。
import type { PermissionRuleValue } from '../types.js';

/**
 * 转义规则内容以便安全存储。顺序敏感：先转义反斜杠，再转义括号。
 * escapeRuleContent('psycopg2.connect()') // => 'psycopg2.connect\\(\\)'
 */
export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** unescapeRuleContent 是 escapeRuleContent 的逆序：先括号，后反斜杠。 */
export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/**
 * 解析规则字符串。"ToolName" 或 "ToolName(content)"；
 * 空内容（'Bash()'）与通配（'Bash(*)'）视为整体 Tool 规则。
 */
export function permissionRuleValueFromString(ruleString: string): PermissionRuleValue {
  const openParenIndex = findFirstUnescapedChar(ruleString, '(');
  if (openParenIndex === -1) {
    return { toolName: ruleString };
  }

  const closeParenIndex = findLastUnescapedChar(ruleString, ')');
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
    return { toolName: ruleString };
  }
  if (closeParenIndex !== ruleString.length - 1) {
    return { toolName: ruleString };
  }

  const toolName = ruleString.substring(0, openParenIndex);
  const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex);
  if (!toolName) {
    return { toolName: ruleString };
  }
  if (rawContent === '' || rawContent === '*') {
    return { toolName };
  }

  return { toolName, ruleContent: unescapeRuleContent(rawContent) };
}

export function permissionRuleValueToString(ruleValue: PermissionRuleValue): string {
  if (!ruleValue.ruleContent) {
    return ruleValue.toolName;
  }
  return `${ruleValue.toolName}(${escapeRuleContent(ruleValue.ruleContent)})`;
}

/** 整体 Tool 匹配：ruleContent 为空 + toolName 相等。中央唯一懂的规则语义。 */
export function matchesWholeTool(ruleValue: PermissionRuleValue, toolName: string): boolean {
  return ruleValue.ruleContent === undefined && ruleValue.toolName === toolName;
}

/** 第一个未转义字符的位置；前面有奇数个反斜杠视为转义。 */
function findFirstUnescapedChar(str: string, char: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === '\\') {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** 最后一个未转义字符的位置；前面有奇数个反斜杠视为转义。 */
function findLastUnescapedChar(str: string, char: string): number {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === '\\') {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) {
        return i;
      }
    }
  }
  return -1;
}
