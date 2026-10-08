import { describe, expect, it } from 'vitest';
import {
  emptyChatDraft,
  hasDraftContent,
  restoreFailedDraft,
} from '../src/stores/chatDraft.js';

describe('草稿附件不依赖知识库', () => {
  it('空草稿不再持有 KB 范围, 普通本地文件引用仍可发送', () => {
    const draft = emptyChatDraft();
    expect(draft).not.toHaveProperty('selectedAssetIds');
    expect(hasDraftContent(draft)).toBe(false);
    expect(hasDraftContent({
      ...draft,
      references: [{ draftId: 'file', type: 'file_reference', path: 'D:/documents/example.pdf' }],
    })).toBe(true);
  });

  it('提交失败时保留原附件和等待期间新输入的附件', () => {
    const submitted = {
      ...emptyChatDraft(),
      text: '请读取 PDF',
      references: [{ draftId: 'file', type: 'file_reference' as const, path: 'D:/documents/example.pdf' }],
    };
    const current = {
      ...emptyChatDraft(),
      text: '补充文字',
      references: [{ draftId: 'image', type: 'image' as const, sourcePath: 'D:/documents/image.png' }],
    };
    const restored = restoreFailedDraft(submitted, current);
    expect(restored.text).toBe('请读取 PDF补充文字');
    expect(restored.references).toEqual([...submitted.references, ...current.references]);
  });
});
