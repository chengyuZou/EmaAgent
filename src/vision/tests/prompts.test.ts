import { describe, expect, it } from 'vitest';
import { buildVisionExtractionPrompt, defaultMaxTokensForVisionTask } from '../prompts.js';

describe('Vision Prompt', () => {
  it('只要求当前结果读取的字段, 固定说明使用英文半角标点', () => {
    const prompt = buildVisionExtractionPrompt({ task: 'layout', imageCount: 2 });
    expect(prompt).toContain('Task: layout');
    expect(prompt).toContain('Images: 2');
    expect(prompt).toContain('"text"');
    expect(prompt).toContain('"blocks"');
    expect(prompt).not.toContain('"warnings"');
    expect(prompt).toMatch(/^[\x00-\x7f]*$/);
  });

  it('调用方的语言和补充指令原样进入 Prompt, 不改写其中文标点', () => {
    const prompt = buildVisionExtractionPrompt({
      task: 'caption', imageCount: 1, language: '中文', instruction: '请描述图片，保留原文。',
    });
    expect(prompt).toContain('Preferred output language: 中文.');
    expect(prompt).toContain('请描述图片，保留原文。');
  });

  it('各任务使用当前输出预算', () => {
    expect(defaultMaxTokensForVisionTask('auto')).toBe(2048);
    expect(defaultMaxTokensForVisionTask('caption')).toBe(1024);
    expect(defaultMaxTokensForVisionTask('ocr')).toBe(2048);
    expect(defaultMaxTokensForVisionTask('layout')).toBe(4096);
    expect(defaultMaxTokensForVisionTask('table')).toBe(4096);
  });
});
