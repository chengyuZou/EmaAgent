// 规则解析实现来源: Claude utils/permissions/permissionRuleParser.ts.
import type { PermissionRuleKey } from '../types.js';

/**
 * 转义规则内容以便保存. 顺序敏感: 先转义反斜杠, 再转义括号.
 * escapeRuleContent('psycopg2.connect()') // => 'psycopg2.connect\\(\\)'
 */
export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** unescapeRuleContent 是 escapeRuleContent 的逆序: 先括号, 后反斜杠. */
export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/**
 * 解析 ToolName 或 ToolName(content). 空内容和单独的星号视为整个工具的规则.
 * 括号不完整或闭括号后仍有文本时, 整个字符串作为工具名, 不猜测批准范围.
 */
export function parsePermissionRuleKey(ruleString: string): PermissionRuleKey {
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

  return { toolName, condition: unescapeRuleContent(rawContent) };
}

export function formatPermissionRuleKey(key: PermissionRuleKey): string {
  if (!key.condition) {
    return key.toolName;
  }
  return `${key.toolName}(${escapeRuleContent(key.condition)})`;
}

export function matchesWholeTool(key: PermissionRuleKey, toolName: string): boolean {
  return key.condition === undefined && key.toolName === toolName;
}

/** 前面有奇数个反斜杠时, 当前括号属于内容, 不是规则分隔符. */
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
