// 渲染直接以数字保存的参数, 不承担单位换算或业务范围定义.

import { useEffect, useState, type JSX } from 'react';
import { Button, Input } from '@ema-agent/ui';
import type { SettingApply } from '../../../api/settings.js';
import { showToast } from '../../../lib/toast.js';
import { SaveStateIndicator, SettingItem } from '../../shared/SettingItem.js';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export function NumberSetting(props: {
  title: string;
  hint: string;
  apply: SettingApply;
  value: number;
  unit?: string;
  onSave(value: number): Promise<void>;
  onReset(): Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(String(props.value));
  const [state, setState] = useState<SaveState>('idle');
  useEffect(() => setDraft(String(props.value)), [props.value]);

  async function save(): Promise<void> {
    const value = Number(draft);
    if (!Number.isFinite(value)) {
      setDraft(String(props.value));
      return;
    }
    if (value === props.value) return;
    setState('saving');
    try {
      await props.onSave(value);
      setState('saved');
    } catch (cause: unknown) {
      setState('failed');
      showToast(cause instanceof Error ? cause.message : '参数保存失败', { variant: 'danger' });
    }
  }

  async function reset(): Promise<void> {
    setState('saving');
    try {
      await props.onReset();
      setState('saved');
    } catch (cause: unknown) {
      setState('failed');
      showToast(cause instanceof Error ? cause.message : '恢复默认失败', { variant: 'danger' });
    }
  }

  return (
    <SettingItem title={props.title} hint={props.hint} apply={props.apply}>
      <SaveStateIndicator state={state} />
      <Input
        className="w-32"
        inputSize="sm"
        type="number"
        value={draft}
        disabled={state === 'saving'}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      />
      {props.unit && <span className="text-xs text-[var(--ema-text-tertiary)]">{props.unit}</span>}
      <Button variant="ghost" size="sm" onClick={() => void reset()} title="恢复默认值">
        <span className="i-lucide:rotate-ccw" aria-hidden />
      </Button>
    </SettingItem>
  );
}
