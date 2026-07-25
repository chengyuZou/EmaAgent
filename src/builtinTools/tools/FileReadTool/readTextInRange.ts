// 按行范围读取文本文件: 小文件快路径整读, 大文件流式只保留选中行。
// 内存占用由选中范围决定, 不由文件大小决定——读 100 GB 文件的第 1 行不会爆 RSS。
import fs from 'node:fs';

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024; // 10 MiB, 与 FileReadTool 整文件上限一致
/** 选中内容累计的字节预算: 超出即截断, 防单行巨行/大范围选择把内存打满。 */
const MAX_SELECTED_BYTES = 256 * 1024;

export interface TextRangeResult {
  /** 选中行(已剥 BOM 与行尾 \r)。 */
  lines: string[];
  /** 文件总行数(与 split('\n') 口径一致: 换行数 + 1)。 */
  totalLines: number;
  /** 选中内容超过字节预算被截断。 */
  truncated: boolean;
  /** 快路径的完整原文(未剥 BOM/\r, 供 FileEdit 防覆盖精确比对); 流式路径无。 */
  raw?: string;
}

/**
 * 读取 [offset, offset+limit) 行(1 起行号)。
 * stat 由调用方提供(避免重复 stat); 大文件或设备类走 createReadStream,
 * signal 可取消流。
 */
export async function readTextInRange(
  filePath: string,
  stat: fs.Stats,
  offset: number,
  limit: number | undefined,
  signal?: AbortSignal,
): Promise<TextRangeResult> {
  if (stat.isFile() && stat.size <= FAST_PATH_MAX_SIZE) {
    return readFast(filePath, offset, limit, signal);
  }
  return readStreaming(filePath, offset, limit, signal);
}

// ── 快路径: 整读 + 内存切片(小文件快约 2 倍) ──────────────────────────────────

async function readFast(
  filePath: string,
  offset: number,
  limit: number | undefined,
  signal?: AbortSignal,
): Promise<TextRangeResult> {
  const raw = await fs.promises.readFile(filePath, { encoding: 'utf8', signal });
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const all = text.split('\n').map(stripCr);
  const selected = all.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);

  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const line of selected) {
    const next = bytes + (lines.length > 0 ? 1 : 0) + Buffer.byteLength(line);
    if (next > MAX_SELECTED_BYTES) { truncated = true; break; }
    bytes = next;
    lines.push(line);
  }
  return { lines, totalLines: all.length, truncated, raw };
}

// ── 流式路径: 只累计选中行, 其余只数 \n ────────────────────────────────────────

function readStreaming(
  filePath: string,
  offset: number,
  limit: number | undefined,
  signal?: AbortSignal,
): Promise<TextRangeResult> {
  return new Promise((resolve, reject) => {
    let endLine = limit === undefined ? Infinity : offset - 1 + limit;
    const stream = fs.createReadStream(filePath, {
      encoding: 'utf8',
      highWaterMark: 512 * 1024,
      ...(signal ? { signal } : {}),
    });

    const lines: string[] = [];
    let selectedBytes = 0;
    let truncated = false;
    let lineIndex = 0;       // 0 基行号
    let partial = '';        // 跨 chunk 的行碎片
    let isFirstChunk = true;

    // 选中一行: 预算内才落袋, 超出即截断且不再累计(行数照常统计)。
    const pushSelected = (line: string): void => {
      if (truncated) return;
      const next = selectedBytes + (lines.length > 0 ? 1 : 0) + Buffer.byteLength(line);
      if (next > MAX_SELECTED_BYTES) {
        truncated = true;
        return;
      }
      selectedBytes = next;
      lines.push(line);
    };

    stream.on('data', (raw: string | Buffer) => {
      let chunk = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (isFirstChunk) {
        isFirstChunk = false;
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      }
      const data = partial + chunk;
      partial = '';

      let startPos = 0;
      let newlinePos: number;
      while ((newlinePos = data.indexOf('\n', startPos)) !== -1) {
        if (lineIndex >= offset - 1 && lineIndex < endLine) {
          pushSelected(stripCr(data.slice(startPos, newlinePos)));
        }
        lineIndex++;
        startPos = newlinePos + 1;
      }
      // 未完成的行尾碎片: 只有落在选中范围才值得留。
      if (startPos < data.length && lineIndex >= offset - 1 && lineIndex < endLine) {
        const fragment = data.slice(startPos);
        if (selectedBytes + Buffer.byteLength(fragment) <= MAX_SELECTED_BYTES) {
          partial = fragment;
        } else {
          // 巨行碎片: 截断并收缩选中范围, 防止无换行大文件把 partial 撑爆。
          truncated = true;
          endLine = lineIndex;
        }
      }
    });

    stream.once('end', () => {
      // 与 split('\n') 口径一致: 末尾片段(含空串)也算一行, 在范围内才落袋。
      if (lineIndex >= offset - 1 && lineIndex < endLine) {
        pushSelected(stripCr(partial));
      }
      lineIndex++;
      resolve({ lines, totalLines: lineIndex, truncated });
    });
    stream.once('error', reject);
  });
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
