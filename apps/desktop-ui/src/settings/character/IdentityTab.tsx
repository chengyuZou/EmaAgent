/**
 * IdentityTab — edit name, description, systemPrompt.
 */
import { useState, type FormEvent, type JSX } from 'react';
import { Button, Field, Input, Textarea } from '@ema-agent/ui';
import { useCardStore } from '../../stores/card-store.js';
import type { CharacterCard } from '../../api/cards.js';
import { showToast } from '../../lib/toast.js';
import type { CharacterCardId } from '@ema-agent/ids';

export function IdentityTab({ card }: { card: CharacterCard }): JSX.Element {
  const [name,         setName]         = useState(card.name);
  const [description,  setDescription]  = useState(card.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(card.systemPrompt);
  const [saving,       setSaving]       = useState(false);
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
    <form onSubmit={handleSave} className="flex flex-col gap-4 max-w-lg pt-3">
      <Field label="名称">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isBuiltin}
        />
      </Field>

      <Field label="描述">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isBuiltin}
        />
      </Field>

      <Field label="System Prompt">
        <Textarea
          minRows={10}
          maxRows={20}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          disabled={isBuiltin}
          className="font-mono"
        />
      </Field>

      {isBuiltin && (
        <p className="text-xs text-[var(--ema-warning)]">内置角色卡不可修改身份信息，可复制后修改。</p>
      )}

      {!isBuiltin && (
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            保存
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setName(card.name);
              setDescription(card.description ?? '');
              setSystemPrompt(card.systemPrompt);
            }}
          >
            撤销
          </Button>
        </div>
      )}
    </form>
  );
}
