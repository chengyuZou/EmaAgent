// 测试 JSONL 编解码:回环、分块边界、非法行、严格截断末行与双上限。
import { describe, expect, it } from 'vitest';
import {
  JsonlDecoder,
  JsonlParseError,
  decodeJsonl,
  encodeJsonlLine,
  encodeJsonlLines,
} from '../records/jsonl.js';

const OPTS = { entryName: 'records/test.jsonl', maxRecords: 100 };

function encodeAll(rows: unknown[]): Uint8Array {
  const parts = [...encodeJsonlLines(rows)];
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe('编码与回环', () => {
  it('回环保持记录与顺序', () => {
    const rows = [{ a: 1 }, { b: '中文' }, { c: [1, 2, 3] }];
    const decoded = decodeJsonl(new TextDecoder().decode(encodeAll(rows)), OPTS);
    expect(decoded).toEqual(rows);
  });

  it('每行恒以换行终止', () => {
    const line = new TextDecoder().decode(encodeJsonlLine({ a: 1 }));
    expect(line.endsWith('\n')).toBe(true);
  });

  it('空输入产出空集合', () => {
    expect(decodeJsonl('', OPTS)).toEqual([]);
    expect(decodeJsonl('\n\n', OPTS)).toEqual([]);
  });
});

describe('JsonlDecoder 增量分块', () => {
  it('行中间断块也能正确拼合', () => {
    const bytes = encodeAll([{ x: 1 }, { x: 2 }]);
    const d = new JsonlDecoder(OPTS);
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      out.push(...d.push(bytes.subarray(i, i + 3)));
    }
    out.push(...d.finalize());
    expect(out).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('多字节字符中间断块不损坏 UTF-8', () => {
    const bytes = encodeAll([{ name: '艾玛中文名' }]);
    const d = new JsonlDecoder(OPTS);
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 1) {
      out.push(...d.push(bytes.subarray(i, i + 1)));
    }
    out.push(...d.finalize());
    expect(out).toEqual([{ name: '艾玛中文名' }]);
  });

  it('两个实例交错解码互不污染流状态', () => {
    const a = encodeAll([{ side: '甲中文' }]);
    const b = encodeAll([{ side: '乙中文' }]);
    const da = new JsonlDecoder(OPTS);
    const db = new JsonlDecoder(OPTS);
    const outA: unknown[] = [];
    const outB: unknown[] = [];
    // 交错逐字节喂两个实例,共用 decoder 时会把两侧断字节拼错
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (i < a.length) outA.push(...da.push(a.subarray(i, i + 1)));
      if (i < b.length) outB.push(...db.push(b.subarray(i, i + 1)));
    }
    outA.push(...da.finalize());
    outB.push(...db.finalize());
    expect(outA).toEqual([{ side: '甲中文' }]);
    expect(outB).toEqual([{ side: '乙中文' }]);
  });

  it('非法 UTF-8 拒绝', () => {
    const d = new JsonlDecoder(OPTS);
    expect(() => d.push(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow(JsonlParseError);
  });
});

describe('拒绝规则', () => {
  it('非法 JSON 行报行号', () => {
    expect(() => decodeJsonl('{"ok":1}\n{bad json}\n', OPTS)).toThrow(/第 2 行/);
  });

  it('末行缺终止换行视为截断,即使内容合法也拒绝', () => {
    expect(() => decodeJsonl('{"ok":1}', OPTS)).toThrow(/截断/);
    expect(() => decodeJsonl('{"ok":1}\n{"also":2}', OPTS)).toThrow(/截断/);
    expect(() => decodeJsonl(' \t', OPTS)).toThrow(/截断/);
  });

  it('单行超长拒绝', () => {
    const d = new JsonlDecoder({ entryName: 't', maxRecords: 100, maxLineBytes: 16 });
    const big = encodeJsonlLine({ payload: 'x'.repeat(64) });
    expect(() => d.push(big)).toThrow(/超过 16 字节/);
  });

  it('记录数超限拒绝', () => {
    const d = new JsonlDecoder({ entryName: 't', maxRecords: 2 });
    const bytes = encodeAll([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(() => d.push(bytes)).toThrow(/超过 2 条/);
  });

  it('巨型单行按原始字节跨分块累计', () => {
    const d = new JsonlDecoder({ entryName: 't', maxRecords: 100, maxLineBytes: 8 });
    const bytes = new TextEncoder().encode('123456789');
    for (let i = 0; i < 8; i += 1) {
      expect(() => d.push(bytes.subarray(i, i + 1))).not.toThrow();
    }
    expect(() => d.push(bytes.subarray(8))).toThrow(/超过 8 字节/);
  });
});
