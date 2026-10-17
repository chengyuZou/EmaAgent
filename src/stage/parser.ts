import type {
  CharacterTagKind,
  ParsedCharacterTag,
  ScanResult,
} from './types.js';

const COMPLETE_TAG_RE = /<(emotion|motion)>\s*([a-z][a-z0-9_]*)\s*<\/\1>/gu;
const TAG_OPENINGS = ['<emotion>', '<motion>'] as const;
// 模型一直不闭合标签时, 不能让后续正文全部留在缓冲区.
const MAX_BUFFERED_TAG_LENGTH = 128;

/** 保留尚未完整的标签片段, 等下一段文本到达后继续识别. */
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

  /** 流结束时将未闭合标签按普通正文返回, 避免丢掉模型输出. */
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

    // lastIndexOf 的负 position 会被夹到 0; 单独推进搜索上界, 保证索引 0 只检查一次.
    searchFrom = index - 1;
  }
  return -1;
}
