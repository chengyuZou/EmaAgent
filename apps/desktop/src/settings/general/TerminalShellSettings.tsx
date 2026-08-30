// 检测本机可用 Shell，并保存以后新建集成终端采用的可执行文件。
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Callout, Select } from '@ema-agent/ui';

import { settingsApi } from '../../api/settings.js';
import {
  tauriBridge,
  type DetectedTerminalShell,
  type TerminalShellKind,
} from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';
import {
  SaveStateIndicator,
  SettingItem,
  SettingsCard,
  SettingsSection,
} from '../shared/SettingItem.js';

const SETTING_KEY = 'frontend.terminal.shellExecutable';
const AUTO_SHELL_VALUE = '__ema_auto_shell__';
const SHELL_KIND_LABELS: Readonly<Record<TerminalShellKind, string>> = {
  powerShell: 'PowerShell',
  commandPrompt: 'Command Prompt',
  bash: 'Bash',
  zsh: 'Zsh',
  fish: 'Fish',
  wsl: 'WSL',
  sh: 'POSIX Shell',
};

type LoadState = 'loading' | 'ready' | 'failed';
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export function TerminalShellSettings(): JSX.Element {
  const [shells, setShells] = useState<readonly DetectedTerminalShell[]>([]);
  const [selected, setSelected] = useState('');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    let active = true;
    void Promise.all([
      tauriBridge.listTerminalShells(),
      settingsApi.getValue(SETTING_KEY),
    ]).then(([detected, setting]) => {
      if (!active) return;
      setShells(detected);
      setSelected(typeof setting.value === 'string' ? setting.value : '');
      setLoadState('ready');
    }).catch((cause: unknown) => {
      if (!active) return;
      setLoadState('failed');
      showToast(cause instanceof Error ? cause.message : '终端 Shell 检测失败', { variant: 'danger' });
    });
    return () => { active = false; };
  }, []);

  const options = useMemo(() => {
    const labelCounts = new Map<string, number>();
    for (const shell of shells) labelCounts.set(shell.label, (labelCounts.get(shell.label) ?? 0) + 1);
    const detectedOptions = shells.map((shell) => ({
      value: shell.executablePath,
      label: labelCounts.get(shell.label) === 1
        ? shell.label
        : `${shell.label} — ${shell.executablePath}`,
    }));
    if (selected && !shells.some((shell) => shell.executablePath === selected)) {
      detectedOptions.push({ value: selected, label: `不可用 — ${selected}` });
    }
    return [
      { value: AUTO_SHELL_VALUE, label: shells[0] ? `自动选择（${shells[0].label}）` : '自动选择' },
      ...detectedOptions,
    ];
  }, [selected, shells]);

  async function save(value: string): Promise<void> {
    setSaveState('saving');
    try {
      const result = await settingsApi.putValue(SETTING_KEY, value);
      setSelected(typeof result.value === 'string' ? result.value : '');
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1_200);
    } catch (cause: unknown) {
      setSaveState('failed');
      showToast(cause instanceof Error ? cause.message : '终端 Shell 保存失败', { variant: 'danger' });
    }
  }

  const selectedShell = shells.find((shell) => shell.executablePath === selected);
  return (
    <SettingsSection
      icon="i-lucide:terminal"
      title="集成终端"
      description="检测本机可用 Shell，并决定以后新建的终端使用哪一个。"
      trailing={<SaveStateIndicator state={saveState} />}
    >
      {loadState === 'failed' ? (
        <Callout variant="danger">无法读取本机 Shell。</Callout>
      ) : (
        <SettingsCard>
          <SettingItem
            title="Shell"
            hint={selectedShell
              ? `${SHELL_KIND_LABELS[selectedShell.kind]} · ${selectedShell.executablePath}`
              : selected
                ? `先前选择的 Shell 当前不可用：${selected}`
                : '由桌面宿主从检测结果中自动选择；已有终端不受更改影响。'}
          >
            <Select
              className="w-72"
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
