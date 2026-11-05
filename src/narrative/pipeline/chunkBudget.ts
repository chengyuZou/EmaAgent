import type { NarrativeChunkRow } from '@ema-agent/storage';

// 按重排顺序保留完整原文块. 预算包含 JSON 数组、转义和逗号, 放不下下一块时停止.
export function selectChunksWithinBudget(
  chunks: readonly NarrativeChunkRow[],
  characterLimit: number,
): NarrativeChunkRow[] {
  let usedCharacters = 2;
  const selectedChunks: NarrativeChunkRow[] = [];
  for (const chunk of chunks) {
    const line = JSON.stringify({ chunk_id: chunk.chunk_id, content: chunk.content });
    const length = line.length + (selectedChunks.length > 0 ? 1 : 0);
    if (usedCharacters + length > characterLimit) {
      break;
    }
    usedCharacters += length;
    selectedChunks.push(chunk);
  }
  return selectedChunks;
}
