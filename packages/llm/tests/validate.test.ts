import { describe, it, expect } from 'vitest';
import { validateContentParts } from '../src/validate.js';
import type { LlmContentPart } from '../src/types.js';

const text:       LlmContentPart = { type: 'text',       text: 'hello' };
const imageUrl:   LlmContentPart = { type: 'image_url',  url: 'https://example.com/cat.jpg' };
const imageData:  LlmContentPart = { type: 'image_data', data: 'abc=', mimeType: 'image/png' };
const imageJpeg:  LlmContentPart = { type: 'image_data', data: 'abc=', mimeType: 'image/jpeg' };
const imageGif:   LlmContentPart = { type: 'image_data', data: 'abc=', mimeType: 'image/gif' };
const imageWebp:  LlmContentPart = { type: 'image_data', data: 'abc=', mimeType: 'image/webp' };
const imageBmp:   LlmContentPart = { type: 'image_data', data: 'abc=', mimeType: 'image/bmp' };
const audioWav:   LlmContentPart = { type: 'audio_data', data: 'abc=', mimeType: 'audio/wav' };
const audioMp3:   LlmContentPart = { type: 'audio_data', data: 'abc=', mimeType: 'audio/mpeg' };
const audioOgg:   LlmContentPart = { type: 'audio_data', data: 'abc=', mimeType: 'audio/ogg' };
const fileData:   LlmContentPart = { type: 'file_data',  data: 'abc=', mimeType: 'application/pdf' };
const fileUrl:    LlmContentPart = { type: 'file_url',   url:  'https://example.com/doc.pdf', mimeType: 'application/pdf' };
const gsImageUrl: LlmContentPart = { type: 'image_url',  url: 'gs://my-bucket/img.jpg' };
const gsFileUrl:  LlmContentPart = { type: 'file_url',   url: 'gs://my-bucket/doc.pdf', mimeType: 'application/pdf' };

// ── OpenAI / openai-compat ────────────────────────────────────────────────────

for (const provider of ['openai', 'openai-compat'] as const) {
  describe(`validateContentParts — ${provider}`, () => {
    it('accepts text',         () => expect(validateContentParts([text],      provider)).toHaveLength(0));
    it('accepts image_url',    () => expect(validateContentParts([imageUrl],  provider)).toHaveLength(0));
    it('accepts image_data',   () => expect(validateContentParts([imageData], provider)).toHaveLength(0));
    it('accepts wav audio',    () => expect(validateContentParts([audioWav],  provider)).toHaveLength(0));
    it('accepts mp3 audio',    () => expect(validateContentParts([audioMp3],  provider)).toHaveLength(0));
    it('rejects file_data',    () => expect(validateContentParts([fileData],  provider)).toHaveLength(1));
    it('rejects file_url',     () => expect(validateContentParts([fileUrl],   provider)).toHaveLength(1));
    it('rejects ogg audio',    () => expect(validateContentParts([audioOgg],  provider)).toHaveLength(1));

    it('returns correct index for rejected part', () => {
      const issues = validateContentParts([text, fileData], provider);
      expect(issues[0]?.index).toBe(1);
    });

    it('allows mixed valid parts with no issues', () => {
      expect(validateContentParts([text, imageUrl, imageData], provider)).toHaveLength(0);
    });

    it('collects all issues in one pass', () => {
      expect(validateContentParts([fileData, audioOgg, fileUrl], provider)).toHaveLength(3);
    });
  });
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

describe('validateContentParts — anthropic', () => {
  it('accepts text',          () => expect(validateContentParts([text],      'anthropic')).toHaveLength(0));
  it('accepts image_url',     () => expect(validateContentParts([imageUrl],  'anthropic')).toHaveLength(0));
  it('accepts image/jpeg',    () => expect(validateContentParts([imageJpeg], 'anthropic')).toHaveLength(0));
  it('accepts image/png',     () => expect(validateContentParts([imageData], 'anthropic')).toHaveLength(0));
  it('accepts image/gif',     () => expect(validateContentParts([imageGif],  'anthropic')).toHaveLength(0));
  it('accepts image/webp',    () => expect(validateContentParts([imageWebp], 'anthropic')).toHaveLength(0));
  it('rejects image/bmp',     () => expect(validateContentParts([imageBmp],  'anthropic')).toHaveLength(1));
  it('rejects audio_data',    () => expect(validateContentParts([audioWav],  'anthropic')).toHaveLength(1));
  it('rejects ogg audio',     () => expect(validateContentParts([audioOgg],  'anthropic')).toHaveLength(1));
  it('accepts file_data',     () => expect(validateContentParts([fileData],  'anthropic')).toHaveLength(0));
  it('accepts file_url',      () => expect(validateContentParts([fileUrl],   'anthropic')).toHaveLength(0));

  it('includes reason in issue', () => {
    const issues = validateContentParts([audioWav], 'anthropic');
    expect(issues[0]?.reason).toContain('audio');
  });
});

// ── Gemini ────────────────────────────────────────────────────────────────────

describe('validateContentParts — gemini', () => {
  it('accepts text',              () => expect(validateContentParts([text],       'gemini')).toHaveLength(0));
  it('accepts image_data',        () => expect(validateContentParts([imageData],  'gemini')).toHaveLength(0));
  it('accepts file_data',         () => expect(validateContentParts([fileData],   'gemini')).toHaveLength(0));
  it('accepts gs:// image_url',   () => expect(validateContentParts([gsImageUrl], 'gemini')).toHaveLength(0));
  it('accepts gs:// file_url',    () => expect(validateContentParts([gsFileUrl],  'gemini')).toHaveLength(0));
  it('rejects https:// image_url',() => expect(validateContentParts([imageUrl],   'gemini')).toHaveLength(1));
  it('rejects https:// file_url', () => expect(validateContentParts([fileUrl],    'gemini')).toHaveLength(1));

  it('includes gs:// hint in reason', () => {
    const issues = validateContentParts([imageUrl], 'gemini');
    expect(issues[0]?.reason).toContain('gs://');
  });
});

// ── Empty input ───────────────────────────────────────────────────────────────

describe('validateContentParts — edge cases', () => {
  it('empty array returns no issues', () => {
    expect(validateContentParts([], 'openai')).toHaveLength(0);
  });

  it('includes the offending part in the issue object', () => {
    const issues = validateContentParts([fileData], 'openai');
    expect(issues[0]?.part).toBe(fileData);
  });
});
