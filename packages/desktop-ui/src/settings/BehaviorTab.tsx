/**
 * BehaviorTab — edit speechPatterns, forbiddenTopics, emotionVocabulary, motionVocabulary.
 */
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useCardStore } from '../stores/card-store.js';
import type { CharacterCard } from '../api/cards.js';
import { showToast } from '../lib/toast.js';
import type { CharacterCardId } from '@ema-agent/contracts';

function TagEditor({ tags, onChange, placeholder }: { tags: string[]; onChange(tags: string[]): void; placeholder: string }): JSX.Element {
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
    <div>
      <div className="flex flex-wrap gap-1 mb-2">
        {tags.map((tag, i) => (
          <span key={`${tag}-${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-gray-700 text-xs text-gray-200">
            {tag}
            <button type="button" className="text-gray-500 hover:text-red-400" onClick={() => removeTag(i)}>×</button>
          </span>
        ))}
      </div>
      <input
        className="w-full bg-gray-800 border border-gray-600 rounded-xl px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
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
        motionVocabulary: motionVocab,
      });
      showToast('已保存', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`保存失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-4 max-w-lg">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-400">说话风格模式</label>
        <TagEditor tags={speechPatterns} onChange={setSpeechPatterns} placeholder="添加模式…" />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-400">禁止话题</label>
        <TagEditor tags={forbiddenTopics} onChange={setForbiddenTopics} placeholder="添加话题…" />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-400">情感词汇（控制 Live2D 表情）</label>
        <TagEditor tags={emotionVocab} onChange={setEmotionVocab} placeholder="添加情绪词…" />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-400">动作词汇（控制 Live2D 动作）</label>
        <TagEditor tags={motionVocab} onChange={setMotionVocab} placeholder="添加动作词…" />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="self-start px-4 py-2 rounded-xl bg-pink-400/20 text-pink-300 text-sm hover:bg-pink-400/30 transition-colors disabled:opacity-50"
      >
        {saving ? '保存中…' : '保存'}
      </button>
    </form>
  );
}
