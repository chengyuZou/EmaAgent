import type { NarrativeChunkRow } from '@ema-agent/storage';

// 按重排顺序保留完整原文块. 预算包含 JSON 转义及块之间的换行, 放不下下一块时停止.
export function buildContext(chunks: readonly NarrativeChunkRow[], characterLimit: number): string {
  let used = 0;
  const lines: string[] = [];
  for (const chunk of chunks) {
    const line = JSON.stringify({ chunk_id: chunk.chunk_id, content: chunk.content });
    const length = line.length + (lines.length > 0 ? 1 : 0);
    if (used + length > characterLimit) {
      break;
    }
    used += length;
    lines.push(line);
  }
  return lines.join('\n');
}
