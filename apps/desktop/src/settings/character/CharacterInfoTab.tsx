// 角色信息:name 只读,展示名/描述/舞台显示草稿制,Persona Prompt 随输入增高。
// [设为当前][打开文件夹][删除角色] 放右上;当前角色有工作在跑时后端 409,前端拒绝。
import { useEffect, useState, type JSX } from 'react';
import { Button, Input, Select, Textarea } from '@ema-agent/ui';
import { ServerApiError } from '../../api/client.js';
import {
  charactersApi,
  type Character,
  type CharacterPatchInput,
} from '../../api/characters.js';
import { useCharacterStore } from '../../stores/character.js';
import { showToast } from '../../lib/toast.js';

export function CharacterInfoTab({ character }: { character: Character }): JSX.Element {
  const activeName = useCharacterStore(s => s.activeName);
  const isActive = character.name === activeName;
  const [displayName, setDisplayName] = useState(character.displayName ?? '');
  const [description, setDescription] = useState(character.description ?? '');
  const [stageKind, setStageKind] = useState(character.stageKind);
  const [personaPrompt, setPersonaPrompt] = useState(character.personaPrompt);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDisplayName(character.displayName ?? '');
    setDescription(character.description ?? '');
    setStageKind(character.stageKind);
    setPersonaPrompt(character.personaPrompt);
  }, [character]);

  const dirty = displayName !== (character.displayName ?? '')
    || description !== (character.description ?? '')
    || stageKind !== character.stageKind
    || personaPrompt !== character.personaPrompt;

  async function handleSave(): Promise<void> {
    setSaving(true);
    try {
      const textPatch: CharacterPatchInput = {
        ...(displayName !== (character.displayName ?? '')
          ? { displayName: displayName.trim() || null }
          : {}),
        ...(description !== (character.description ?? '')
          ? { description: description.trim() || null }
          : {}),
        ...(personaPrompt !== character.personaPrompt ? { personaPrompt } : {}),
      };
      if (Object.keys(textPatch).length > 0) {
        await useCharacterStore.getState().patch(character.name, textPatch);
      }
      if (stageKind !== character.stageKind) {
        await useCharacterStore.getState().patch(character.name, { stageKind });
      }
      showToast('已保存', { variant: 'success' });
    } catch (error) {
      if (error instanceof ServerApiError && error.code === 'character_work_running') {
        showToast('Session 活跃期间不能修改舞台显示', { variant: 'warning' });
        return;
      }
      showToast(error instanceof Error ? `保存失败:${error.message}` : '保存失败', { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(): Promise<void> {
    try {
      await useCharacterStore.getState().activate(character.name);
      showToast('已切换角色', { variant: 'success' });
    } catch (error) {
      if (error instanceof ServerApiError && error.code === 'character_work_running') {
        showToast('当前角色有正在执行的任务,请先停止或等其结束后再切换', { variant: 'warning' });
        return;
      }
      showToast(error instanceof Error ? `切换失败:${error.message}` : '切换失败', { variant: 'danger' });
    }
  }

  async function handleOpenFolder(): Promise<void> {
    try {
      const { path } = await charactersApi.location(character.name);
      await charactersApi.openDirectory(path);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开文件夹失败', { variant: 'danger' });
    }
  }

  return (
    <div className="h-full overflow-y-auto p-5 ema-stagger-in">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold text-[var(--ema-text-primary)]">
            {isActive ? '●' : '○'} {character.name}
            {character.displayName ? ` (${character.displayName})` : ''}
          </span>
          <div className="flex-1" />
          {!isActive && (
            <Button variant="primary" size="sm" onClick={() => void handleActivate()}>
              设为当前
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => void handleOpenFolder()}>
            打开文件夹
          </Button>
        </div>

        <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] p-4">
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 ">
            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-[var(--ema-text-tertiary)]">name</span>
              <span className="text-sm text-[var(--ema-text-primary)]">
                {character.name}
                <span className="ml-2 text-[11px] text-[var(--ema-text-tertiary)]">永久身份,不可修改</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-[var(--ema-text-tertiary)]">展示名(可空)</span>
              <Input mono={false} value={displayName} onChange={e => setDisplayName(e.target.value)} className="flex-1" />
            </div>
            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-[var(--ema-text-tertiary)]">描述</span>
              <Input mono={false} value={description} onChange={e => setDescription(e.target.value)} className="flex-1" />
            </div>
            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-[var(--ema-text-tertiary)]">舞台显示</span>
              <Select
                className="flex-1"
                value={stageKind}
                options={[
                  { value: 'live2d', label: 'Live2D' },
                  { value: 'illustration', label: '插图' },
                  { value: 'blank', label: '空白' },
                ]}
                onChange={value => setStageKind(value as Character['stageKind'])}
              />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] p-4">
          <p className="mb-1 text-xs font-semibold text-[var(--ema-text-secondary)]">Persona Prompt</p>
          <p className="mb-2 text-[11px] text-[var(--ema-text-tertiary)]">
            告诉 AI 她是怎样的人;每次对话开场注入人格设定。
          </p>
          <Textarea
            value={personaPrompt}
            onChange={e => setPersonaPrompt(e.target.value)}
            minRows={7}
            maxRows={18}
            className="min-h-[64px] w-full resize-none border-none overflow-y-auto rounded-[22px] bg-transparent px-4 py-3 text-sm text-[var(--ema-text-primary)] placeholder:text-[var(--ema-text-tertiary)] focus:outline-none"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty}
            onClick={() => {
              setDisplayName(character.displayName ?? '');
              setDescription(character.description ?? '');
              setStageKind(character.stageKind);
              setPersonaPrompt(character.personaPrompt);
            }}
          >
            取消
          </Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={() => void handleSave()}>
            保存修改
          </Button>
        </div>
      </div>
    </div>
  );
}
