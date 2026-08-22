// 逐行编解码 JSONL，避免把整份记录文件一次性读入内存。
import fs from 'node:fs';

const MAX_LINE_BYTES = 16 * 1024 * 1024;

export function encodeJsonlRecord(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

export async function* readJsonl<T>(
  filePath: string,
  parse: (value: unknown) => T,
): AsyncGenerator<T> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let pendingBytes = 0;
  let lineNumber = 0;

  for await (const rawChunk of fs.createReadStream(filePath)) {
    const chunk = rawChunk as Buffer;
    pendingBytes += chunk.byteLength;
    if (pendingBytes > MAX_LINE_BYTES && !chunk.includes(10)) {
      throw new Error(`JSONL 单行超过 ${MAX_LINE_BYTES} 字节`);
    }
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      lineNumber += 1;
      pendingBytes = Buffer.byteLength(pending, 'utf8');
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        throw new Error(`JSONL 第 ${lineNumber} 行超过 ${MAX_LINE_BYTES} 字节`);
      }
      if (line.length > 0) yield parseLine(line, lineNumber, parse);
      newline = pending.indexOf('\n');
    }
  }

  pending += decoder.decode();
  if (pending.length > 0) {
    throw new Error('JSONL 最后一行缺少换行符，文件可能未写完整');
  }
}

function parseLine<T>(line: string, lineNumber: number, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(line));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`JSONL 第 ${lineNumber} 行无效: ${message}`);
  }
}
