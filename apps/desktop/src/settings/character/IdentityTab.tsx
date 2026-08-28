/**
 * IdentityTab — edit name, description, personaPrompt.
 */
import { useState, type FormEvent, type JSX } from 'react';
import { Button, Field, Input, Textarea } from '@ema-agent/ui';
import { useCharacterStore } from '../../stores/character.js';
import type { Character } from '../../api/characters.js';
import { showToast } from '../../lib/toast.js';

export function IdentityTab({ character }: { character: Character }): JSX.Element {
  const [name,         setName]         = useState(character.name);
  const [description,  setDescription]  = useState(character.description ?? '');
  const [personaPrompt, setPersonaPrompt] = useState(character.personaPrompt);
  const [saving,       setSaving]       = useState(false);
  const isBuiltin = character.isBuiltin;

  async function handleSave(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (isBuiltin) return;
    setSaving(true);
    try {
      await useCharacterStore.getState().patch(character.id, {
        name,
        description: description || undefined,
        personaPrompt,
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

      <Field label="人设提示词">
        <Textarea
          minRows={10}
          maxRows={20}
          value={personaPrompt}
          onChange={(e) => setPersonaPrompt(e.target.value)}
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
              setName(character.name);
              setDescription(character.description ?? '');
              setPersonaPrompt(character.personaPrompt);
            }}
          >
            撤销
          </Button>
        </div>
      )}
    </form>
  );
}
