// 从 LLM 流式文本中提取角色表现 XML 标签，并把控制标签从用户可见正文中移除。

import type {
  CharacterTagKind,
  ParsedCharacterTag,
  ScanResult,
} from './types.js';

const COMPLETE_TAG_RE = /<(emotion|motion)>\s*([a-z][a-z0-9_]*)\s*<\/\1>/gu;
const TAG_OPENINGS = ['<emotion>', '<motion>'] as const;
const MAX_BUFFERED_TAG_LENGTH = 128;

/** 处理被多个 text delta 拆开的 `<emotion>` 与 `<motion>` 标签。 */
export class StreamingCharacterTagScanner {
  private tail = '';

  scan(delta: string): ScanResult {
    const input = this.tail + delta;
    const tags: ParsedCharacterTag[] = [];
    const cleanedParts: string[] = [];
    let lastEnd = 0;

    COMPLETE_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COMPLETE_TAG_RE.exec(input)) !== null) {
      cleanedParts.push(input.slice(lastEnd, match.index));
      tags.push({
        kind: match[1] as CharacterTagKind,
        value: match[2]!,
        raw: match[0],
      });
      lastEnd = match.index + match[0].length;
    }

    const remainder = input.slice(lastEnd);
    const partialStart = findPartialTagStart(remainder);
    if (partialStart === -1) {
      cleanedParts.push(remainder);
      this.tail = '';
    } else {
      cleanedParts.push(remainder.slice(0, partialStart));
      this.tail = remainder.slice(partialStart);
    }

    return { cleaned: cleanedParts.join(''), tags };
  }

  /** 流结束时，未闭合标签按普通正文释放，避免吞掉模型输出。 */
  flush(): ScanResult {
    const cleaned = this.tail;
    this.tail = '';
    return { cleaned, tags: [] };
  }
}

function findPartialTagStart(text: string): number {
  const lower = text.toLocaleLowerCase('en-US');
  let searchFrom = text.length - 1;
  while (searchFrom >= 0) {
    const index = text.lastIndexOf('<', searchFrom);
    if (index === -1) return -1;

    const tail = lower.slice(index);
    if (tail.length > MAX_BUFFERED_TAG_LENGTH) return -1;
    if (TAG_OPENINGS.some(opening => opening.startsWith(tail) || tail.startsWith(opening))) {
      return index;
    }

    // lastIndexOf 的负 position 会被夹到 0；单独推进搜索上界，保证索引 0 只检查一次。
    searchFrom = index - 1;
  }
  return -1;
}
