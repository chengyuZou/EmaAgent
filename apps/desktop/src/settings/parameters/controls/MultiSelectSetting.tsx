// 渲染固定候选项的字符串多选参数.

import { useState, type JSX } from 'react';
import { Button, Switch } from '@ema-agent/ui';
import type { SettingApply } from '../../../api/settings.js';
import { showToast } from '../../../lib/toast.js';
import { SaveStateIndicator, SettingApplyBadge } from '../../shared/SettingItem.js';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export function MultiSelectSetting(props: {
  title: string;
  hint: string;
  apply: SettingApply;
  value: readonly string[];
  options: readonly { value: string; label: string }[];
  onSave(value: readonly string[]): Promise<void>;
  onReset(): Promise<void>;
}): JSX.Element {
  const [state, setState] = useState<SaveState>('idle');

  async function toggle(value: string, checked: boolean): Promise<void> {
    const next = checked
      ? [...props.value, value]
      : props.value.filter(item => item !== value);
    setState('saving');
    try {
      await props.onSave(next);
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
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[13px] font-medium text-[var(--ema-text-primary)]">{props.title}</div>
            <SettingApplyBadge apply={props.apply} />
          </div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--ema-text-tertiary)]">{props.hint}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SaveStateIndicator state={state} />
          <Button variant="ghost" size="sm" disabled={state === 'saving'} onClick={() => void reset()} title="恢复默认值">
            <span className="i-lucide:rotate-ccw" aria-hidden />
          </Button>
        </div>
      </div>
      <div className="mt-3 divide-y divide-[var(--ema-border)] overflow-hidden rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
        {props.options.map(option => (
          <div key={option.value} className="flex min-h-14 items-center gap-4 px-3 py-2.5 transition-colors duration-[var(--ema-duration-base)] hover:bg-[var(--ema-surface-2)]">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-[var(--ema-text-primary)]">{option.label}</div>
              {option.value !== option.label && (
                <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--ema-text-tertiary)]">{option.value}</div>
              )}
            </div>
            <Switch
              checked={props.value.includes(option.value)}
              disabled={state === 'saving'}
              label={option.label}
              onCheckedChange={checked => void toggle(option.value, checked)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
