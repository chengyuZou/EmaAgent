// 测试输入框文本编辑不会打乱附件与 Skill 在 TurnInputPart[] 中的逻辑位置。
import { describe, expect, it } from 'vitest';
import type { TurnInputPart } from '@ema-agent/turn';
import {
  draftText,
  insertDraftReference,
  removeDraftPart,
  replaceDraftText,
} from '../src/chat/input/composerDraft.js';

describe('composerDraft', () => {
  it('按光标位置插入引用并保留文字顺序', () => {
    let parts: readonly TurnInputPart[] = [{ type: 'text', text: '请分析报告' }];
    parts = insertDraftReference(parts, 3, { type: 'skill', skillKey: 'code-review' });
    parts = insertDraftReference(parts, 5, {
      type: 'attachment',
      attachment: { sourcePath: 'D:/report.pdf', name: 'report.pdf' },
    });
    expect(parts).toEqual([
      { type: 'text', text: '请分析' },
      { type: 'skill', skillKey: 'code-review' },
      { type: 'text', text: '报告' },
      { type: 'attachment', attachment: { sourcePath: 'D:/report.pdf', name: 'report.pdf' } },
    ]);
    expect(draftText(parts)).toBe('请分析报告');
  });

  it('编辑引用前后的文字时保持引用锚点', () => {
    const parts: readonly TurnInputPart[] = [
      { type: 'text', text: '请分析' },
      { type: 'skill', skillKey: 'review' },
      { type: 'text', text: '报告' },
    ];
    expect(replaceDraftText(parts, '请详细分析报告')).toEqual([
      { type: 'text', text: '请详细分析' },
      { type: 'skill', skillKey: 'review' },
      { type: 'text', text: '报告' },
    ]);
  });

  it('删除引用不删除相邻文字', () => {
    const parts: readonly TurnInputPart[] = [
      { type: 'text', text: '前' },
      { type: 'skill', skillKey: 'review' },
      { type: 'text', text: '后' },
    ];
    expect(removeDraftPart(parts, 1)).toEqual([
      { type: 'text', text: '前' },
      { type: 'text', text: '后' },
    ]);
  });
});
