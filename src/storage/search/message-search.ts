import { segmentForFts } from './zh-tokenizer.js';

interface UnknownBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * 从 blocks_json 提取用户在会话界面可见的正文。
 *
 * 只收录字符串消息与 `type=text` block；thinking、tool_use、tool_result、
 * 图片/音频/base64、内部 context 和 metadata 均不会进入通用会话搜索索引。
 */
export function extractMessageSearchText(blocksJson: string): string {
  try {
    const blocks = JSON.parse(blocksJson) as unknown;
    if (typeof blocks === 'string') return normalize(blocks);
    if (!Array.isArray(blocks)) return '';

    const text: string[] = [];
    for (const value of blocks as UnknownBlock[]) {
      if (value?.type === 'text' && typeof value.text === 'string') {
        text.push(value.text);
      }
    }
    return normalize(text.join(' '));
  } catch {
    // 损坏 JSON 不应污染全文索引，也不能阻断消息写入事务。
    return '';
  }
}

export function tokenizeMessageSearchText(text: string): string {
  return segmentForFts(text);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
