// 渲染保存为有限字符串选项的参数.

import { useState, type JSX } from 'react';
import { Button, Select, type SelectOption } from '@ema-agent/ui';
import type { SettingApply } from '../../../api/settings.js';
import { showToast } from '../../../lib/toast.js';
import { SaveStateIndicator, SettingItem } from '../../shared/SettingItem.js';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export function SelectSetting(props: {
  title: string;
  hint: string;
  apply: SettingApply;
  value: string;
  options: SelectOption[];
  onSave(value: string): Promise<void>;
  onReset(): Promise<void>;
}): JSX.Element {
  const [state, setState] = useState<SaveState>('idle');

  async function save(value: string): Promise<void> {
    setState('saving');
    try {
      await props.onSave(value);
      setState('saved');
    } catch (cause: unknown) {
      setState('failed');
      showToast(cause instanceof Error ? cause.message : '参数保存失败', { variant: 'danger' });
    }
  }

  return (
    <SettingItem title={props.title} hint={props.hint} apply={props.apply}>
      <SaveStateIndicator state={state} />
      <Select className="w-48" value={props.value} options={props.options} disabled={state === 'saving'} onChange={value => void save(value)} />
      <Button variant="ghost" size="sm" onClick={() => void props.onReset()} title="恢复默认值">
        <span className="i-lucide:rotate-ccw" aria-hidden />
      </Button>
    </SettingItem>
  );
}
