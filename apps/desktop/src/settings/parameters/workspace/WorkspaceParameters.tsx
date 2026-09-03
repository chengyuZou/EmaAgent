import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { MultiSelectSetting } from '../controls/MultiSelectSetting.js';
import { useSettingValues } from '../useSettingValues.js';

const INSTRUCTION_FILES = 'workspace.instructionFiles';

export function WorkspaceParameters(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <Loading />;
  if (settings.error) return <Callout variant="danger">工作区参数读取失败: {settings.error}</Callout>;

  return (
    <SettingsSection icon="i-lucide:folder-kanban" title="工作区" description="与 Skills 一同注入 Context 的项目指令">
      <SettingsCard>
        <MultiSelectSetting
          title="工作区指令文件"
          hint="按选中顺序读取存在的文件并注入 Context."
          apply={settings.apply(INSTRUCTION_FILES)}
          value={requiredStringArray(settings.values, INSTRUCTION_FILES)}
          options={[{ value: 'CLAUDE.md', label: 'CLAUDE.md' }, { value: 'AGENTS.md', label: 'AGENTS.md' }]}
          onSave={value => settings.save(INSTRUCTION_FILES, value)}
          onReset={() => settings.reset(INSTRUCTION_FILES)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function Loading(): JSX.Element {
  return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
}

function requiredStringArray(values: ReadonlyMap<string, unknown>, key: string): string[] {
  const value = values.get(key);
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`参数 ${key} 没有返回字符串数组`);
  }
  return value;
}
