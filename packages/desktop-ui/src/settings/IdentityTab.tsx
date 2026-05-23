/**
 * IdentityTab — edit name, description, systemPrompt.
 */
import { useState, type FormEvent } from 'react';
import { useCardStore } from '../stores/card-store.js';
import type { CharacterCardWire } from '../api/cards.js';
import { showToast } from '../lib/toast.js';
import type { CharacterCardId } from '@ema-agent/contracts';

export function IdentityTab({ card }: { card: CharacterCardWire }): JSX.Element {
  const [name, setName] = useState(card.name);
  const [description, setDescription] = useState(card.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(card.systemPrompt);
  const [saving, setSaving] = useState(false);
  const isBuiltin = card.isBuiltin;

  async function handleSave(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (isBuiltin) return;
    setSaving(true);
    try {
      await useCardStore.getState().patch(card.id as CharacterCardId, {
        name,
        description: description || undefined,
        systemPrompt,
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
        <label className="text-xs text-gray-400">名称</label>
        <input
          className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isBuiltin}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-400">描述</label>
        <input
          className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isBuiltin}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-gray-400">System Prompt</label>
        <textarea
          className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 resize-none focus:outline-none focus:border-pink-400/50 font-mono"
          rows={10}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          disabled={isBuiltin}
        />
      </div>

      {isBuiltin && (
        <div className="text-xs text-amber-400">内置角色卡不可修改身份信息，可复制后修改。</div>
      )}

      {!isBuiltin && (
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-xl bg-pink-400/20 text-pink-300 text-sm hover:bg-pink-400/30 transition-colors disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="px-4 py-2 rounded-xl text-gray-400 text-sm hover:text-gray-200"
            onClick={() => { setName(card.name); setDescription(card.description ?? ''); setSystemPrompt(card.systemPrompt); }}
          >撤销</button>
        </div>
      )}
    </form>
  );
}
