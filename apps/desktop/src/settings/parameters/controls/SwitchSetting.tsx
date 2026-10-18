import { useState, type JSX } from 'react';
import { Tooltip, Button, Switch } from '@ema-agent/ui';
import type { SettingApply } from '../../../api/settings.js';
import { showToast } from '../../../lib/notifications/toast.js';
import { SaveStateIndicator, SettingItem } from '../../shared/SettingItem.js';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export function SwitchSetting(props: {
  title: string;
  hint: string;
  apply: SettingApply;
  value: boolean;
  onSave(value: boolean): Promise<void>;
  onReset?(): Promise<void>;
}): JSX.Element {
  const [state, setState] = useState<SaveState>('idle');

  async function save(value: boolean): Promise<void> {
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
    if (!props.onReset) return;
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
      <Switch 
        checked={props.value} 
        disabled={state === 'saving'} 
        label={props.title} 
        onCheckedChange={value => void save(value)} 
      />
      {props.onReset && (
        <Tooltip content="恢复默认值">
          <Button
            variant="ghost"
            size="sm"
            disabled={state === 'saving'}
            aria-label="恢复默认值"
            onClick={() => void reset()}
          >
            <span className="i-lucide:rotate-ccw" aria-hidden />
          </Button>
        </Tooltip>
      )}
    </SettingItem>
  );
}
