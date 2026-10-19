import { terminalShellExecutableSetting } from '@ema-agent/server/settings';
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Callout, Select } from '@ema-agent/ui';

import { settingsApi, type SettingApply } from '../../api/settings.js';
import { systemApi, type TerminalShellInfo } from '../../api/system.js';
import { showToast } from '../../lib/notifications/toast.js';
import {
  SaveStateIndicator,
  SettingItem,
  SettingsCard,
  SettingsSection,
} from '../shared/SettingItem.js';

const AUTO_SHELL_VALUE = '__ema_auto_shell__';
type LoadState = 'loading' | 'ready' | 'failed';
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export function TerminalShellSettings(): JSX.Element {
  const [shells, setShells] = useState<readonly TerminalShellInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [apply, setApply] = useState<SettingApply | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    let active = true;
    void Promise.all([
      systemApi.findTerminalShells(),
      settingsApi.getValue(terminalShellExecutableSetting),
    ]).then(([detected, setting]) => {
      if (!active) return;
      setShells(detected.shells);
      setSelected(setting.value);
      setApply(setting.apply);
      setLoadState('ready');
    }).catch((cause: unknown) => {
      if (!active) return;
      setLoadState('failed');
      showToast(cause instanceof Error ? cause.message : '终端 Shell 检测失败', { variant: 'danger' });
    });
    return () => { active = false; };
  }, []);

  // 同 kind 多候选(如 Git 的 bin 与 usr/bin 双 bash)折叠为一项,首选即探测排序首条.
  const collapsed = useMemo(() => {
    const byKind = new Map<TerminalShellInfo['kind'], TerminalShellInfo>();
    for (const shell of shells) {
      if (!byKind.has(shell.kind)) byKind.set(shell.kind, shell);
    }
    return [...byKind.values()];
  }, [shells]);

  const options = useMemo(() => {
    const detectedOptions = collapsed.map((shell) => ({
      value: shell.kind as string,
      label: shell.label,
    }));
    if (selected && !collapsed.some((shell) => shell.kind === selected)) {
      detectedOptions.push({ value: selected, label: `不可用 - ${selected}` });
    }
    return [
      {
        value: AUTO_SHELL_VALUE,
        label: '自动选择',
      },
      ...detectedOptions,
    ];
  }, [selected, collapsed]);

  async function save(value: string): Promise<void> {
    setSaveState('saving');
    try {
      const result = await settingsApi.putValue(terminalShellExecutableSetting, value);
      setSelected(result.value);
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1_200);
    } catch (cause: unknown) {
      setSaveState('failed');
      showToast(cause instanceof Error ? cause.message : '终端 Shell 保存失败', { variant: 'danger' });
    }
  }

  const selectedShell = selected ? collapsed.find(shell => shell.kind === selected) : collapsed[0];
  const selectedLabel = options.find(option => option.value === (selected || AUTO_SHELL_VALUE))?.label;
  let hint = '从检测结果中自动选择, 已有终端不受更改影响.';
  if (selectedShell) {
    hint = `${selected ? '' : '自动选择: '}${selectedShell.label} - ${selectedShell.path}`;
  } else if (selected) {
    hint = `先前选择的 Shell 当前不可用: ${selected}`;
  }
  return (
    <SettingsSection
      icon="i-lucide:terminal"
      title="集成终端"
      description="检测本机可用 Shell, 并决定以后新建的终端使用哪一个."
      trailing={<SaveStateIndicator state={saveState} />}
    >
      {loadState === 'failed' ? (
        <Callout variant="danger">无法读取本机 Shell.</Callout>
      ) : (
        <SettingsCard>
          <SettingItem
            title="Shell"
            apply={apply ?? undefined}
            hint={hint}
          >
            <Select
              className="w-60 max-w-full whitespace-nowrap"
              trigger={<span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>}
              value={selected || AUTO_SHELL_VALUE}
              disabled={loadState === 'loading' || saveState === 'saving'}
              options={options}
              onChange={(value) => void save(value === AUTO_SHELL_VALUE ? '' : value)}
            />
          </SettingItem>
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
