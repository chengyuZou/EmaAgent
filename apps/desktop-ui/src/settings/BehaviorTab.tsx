/**
 * BehaviorTab — edit speechPatterns, forbiddenTopics, emotionVocabulary, motionVocabulary.
 */
import { useState, type FormEvent, type KeyboardEvent, type JSX, type CSSProperties } from 'react';
import { Button, IconButton, Input } from '@ema-agent/ui';
import { useCardStore } from '../stores/card-store.js';
import type { CharacterCard } from '../api/cards.js';
import { showToast } from '../lib/toast.js';
import type { CharacterCardId } from '@ema-agent/contracts';

function TagEditor({
  tags,
  onChange,
  placeholder,
}: {
  tags:        string[];
  onChange:    (tags: string[]) => void;
  placeholder: string;
}): JSX.Element {
  const [input, setInput] = useState('');

  function addTag(): void {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput('');
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag();
    }
  }

  function removeTag(index: number): void {
    onChange(tags.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {tags.map((tag, i) => (
          <span
            key={`${tag}-${i}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[var(--ema-surface-2)] text-xs text-[var(--ema-text-primary)] ema-chip-in"
            style={{ '--stagger-i': i } as CSSProperties}
          >
            {tag}
            <IconButton
              label={`删除 ${tag}`}
              icon="i-mdi:close"
              size="sm"
              variant="default"
              type="button"
              className="w-4 h-4 text-[10px]"
              onClick={() => removeTag(i)}
            />
          </span>
        ))}
      </div>
      <Input
        placeholder={placeholder}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKey}
      />
    </div>
  );
}

export function BehaviorTab({ card }: { card: CharacterCard }): JSX.Element {
  const [speechPatterns, setSpeechPatterns] = useState<string[]>(card.speechPatterns);
  const [forbiddenTopics, setForbiddenTopics] = useState<string[]>(card.forbiddenTopics);
  const [emotionVocab, setEmotionVocab] = useState<string[]>(card.emotionVocabulary);
  const [motionVocab, setMotionVocab] = useState<string[]>(card.motionVocabulary);
  const [saving, setSaving] = useState(false);

  async function handleSave(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    try {
      await useCardStore.getState().patch(card.id as CharacterCardId, {
        speechPatterns,
        forbiddenTopics,
        emotionVocabulary: emotionVocab,
        motionVocabulary:  motionVocab,
      });
      showToast('已保存', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`保存失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-5 max-w-lg pt-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-[var(--ema-text-tertiary)]">说话风格模式</label>
        <TagEditor tags={speechPatterns} onChange={setSpeechPatterns} placeholder="添加模式… (Enter 确认)" />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-[var(--ema-text-tertiary)]">禁止话题</label>
        <TagEditor tags={forbiddenTopics} onChange={setForbiddenTopics} placeholder="添加话题… (Enter 确认)" />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-[var(--ema-text-tertiary)]">情感词汇（控制 Live2D 表情）</label>
        <TagEditor tags={emotionVocab} onChange={setEmotionVocab} placeholder="添加情绪词… (Enter 确认)" />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-[var(--ema-text-tertiary)]">动作词汇（控制 Live2D 动作）</label>
        <TagEditor tags={motionVocab} onChange={setMotionVocab} placeholder="添加动作词… (Enter 确认)" />
      </div>

      <Button type="submit" variant="primary" size="sm" loading={saving} className="self-start">
        保存
      </Button>
    </form>
  );
}
