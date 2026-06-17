import { describe, expect, it } from 'vitest';
import { parseVisionPayload } from '../src/parse.js';

describe('parseVisionPayload', () => {
  it('parses direct JSON payloads', () => {
    const result = parseVisionPayload(JSON.stringify({
      text: 'Invoice total: 42',
      markdown: 'Invoice total: **42**',
      blocks: [
        { id: 'title', kind: 'text', text: 'Invoice', bbox: [0, 0, 1, 0.1], confidence: 0.9 },
      ],
    }));

    expect(result.text).toBe('Invoice total: 42');
    expect(result.markdown).toBe('Invoice total: **42**');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.bbox).toEqual([0, 0, 1, 0.1]);
  });

  it('parses fenced JSON payloads', () => {
    const result = parseVisionPayload('```json\n{"text":"hello","blocks":[]}\n```');

    expect(result.text).toBe('hello');
    expect(result.blocks).toEqual([{ id: 'block-1', kind: 'text', text: 'hello' }]);
  });

  it('falls back to raw text when JSON is invalid', () => {
    const result = parseVisionPayload('plain OCR text');

    expect(result.text).toBe('plain OCR text');
    expect(result.blocks[0]?.text).toBe('plain OCR text');
    expect(result.warnings?.[0]).toContain('vision/output_parse_failed');
  });

  it('throws in strict mode when JSON is invalid', () => {
    expect(() => parseVisionPayload('plain OCR text', { mode: 'strict' }))
      .toThrow('vision/output_parse_failed');
  });
});
