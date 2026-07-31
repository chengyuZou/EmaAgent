// JSONL 编解码:严格写入、增量宽容读取,单行/总行数超限与截断末行一律拒绝。
import { BACKUP_LIMITS } from '../limits.js';

export class JsonlParseError extends Error {
  readonly code = 'backup/jsonl-invalid';

  constructor(
    message: string,
    readonly entryName: string,
    readonly lineNumber?: number,
  ) {
    super(lineNumber === undefined
      ? `${entryName}: ${message}`
      : `${entryName} 第 ${lineNumber} 行: ${message}`);
    this.name = 'JsonlParseError';
  }
}

const encoder = new TextEncoder();

/** 写入侧:一行一个紧凑 JSON,恒以 \n 终止。 */
export function encodeJsonlLine(record: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(record)}\n`);
}

/** 流式写入:逐条产出编码行,不聚合整份文件。 */
export function* encodeJsonlLines(records: Iterable<unknown>): Generator<Uint8Array> {
  for (const record of records) {
    yield encodeJsonlLine(record);
  }
}

export interface JsonlDecodeOptions {
  /** 条目名,只用于错误文案。 */
  entryName: string;
  maxLineBytes?: number;
  maxRecords: number;
}

/**
 * 增量解码器:每个实例持有独立 TextDecoder,多个条目并行解码互不污染流状态。
 * push 任意分块,内部缓冲不完整行;finalize 时仍剩非空缓冲 = 归档被截断,整包拒绝。
 * 空行(纯空白)跳过——写入侧不产生,读取侧容忍条目间空行。
 */
export class JsonlDecoder {
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private lineNumber = 0;
  private records = 0;
  private readonly maxLineBytes: number;

  constructor(private readonly options: JsonlDecodeOptions) {
    this.maxLineBytes = options.maxLineBytes ?? BACKUP_LIMITS.jsonlMaxLineBytes;
  }

  get count(): number {
    return this.records;
  }

  push(chunk: Uint8Array): unknown[] {
    let text: string;
    try {
      text = this.utf8.decode(chunk, { stream: true });
    } catch {
      throw new JsonlParseError('包含非法 UTF-8 字节', this.options.entryName);
    }
    this.buffer += text;
    const out: unknown[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const record = this.consumeLine(line);
      if (record !== undefined) out.push(record);
    }
    if (encoder.encode(this.buffer).byteLength > this.maxLineBytes) {
      throw new JsonlParseError(`单行超过 ${this.maxLineBytes} 字节限制`, this.options.entryName, this.lineNumber + 1);
    }
    return out;
  }

  finalize(): unknown[] {
    let tail: string;
    try {
      tail = this.utf8.decode();
    } catch {
      throw new JsonlParseError('包含非法 UTF-8 字节', this.options.entryName);
    }
    this.buffer += tail;
    const pending = this.buffer;
    this.buffer = '';
    if (pending.trim().length === 0) return [];
    // 严格 V2:末行缺终止换行即截断;规范导出器恒以 \n 结束每一行。
    throw new JsonlParseError('末行不完整,归档被截断', this.options.entryName, this.lineNumber + 1);
  }

  private consumeLine(line: string): unknown {
    const trimmed = line.trim();
    this.lineNumber += 1;
    if (trimmed.length === 0) return undefined;
    if (encoder.encode(trimmed).byteLength > this.maxLineBytes) {
      throw new JsonlParseError(`单行超过 ${this.maxLineBytes} 字节限制`, this.options.entryName, this.lineNumber);
    }
    this.records += 1;
    if (this.records > this.options.maxRecords) {
      throw new JsonlParseError(`记录数超过 ${this.options.maxRecords} 条限制`, this.options.entryName, this.lineNumber);
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new JsonlParseError('不是合法 JSON', this.options.entryName, this.lineNumber);
    }
  }
}

/** 小体量一次性解码(测试辅助;生产导入走 JsonlDecoder 增量路径)。 */
export function decodeJsonl(text: string, options: JsonlDecodeOptions): unknown[] {
  const decoder = new JsonlDecoder(options);
  const out = decoder.push(encoder.encode(text));
  out.push(...decoder.finalize());
  return out;
}
