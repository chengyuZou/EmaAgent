import {
  workspaceInstructionFilesSetting,
  WORKSPACE_INSTRUCTION_FILE_CANDIDATES,
} from '@ema-agent/server/settings';
import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { MultiSelectSetting } from '../../shared/controls/MultiSelectSetting.js';
import { useSettingValues } from '../../shared/useSettingValues.js';

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
          apply={settings.apply(workspaceInstructionFilesSetting)}
          value={settings.get(workspaceInstructionFilesSetting)}
          options={WORKSPACE_INSTRUCTION_FILE_CANDIDATES.map(value => ({ value, label: value }))}
          onSave={value => settings.save(workspaceInstructionFilesSetting, workspaceInstructionFilesSetting.schema.parse(value))}
          onReset={() => settings.reset(workspaceInstructionFilesSetting)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function Loading(): JSX.Element {
  return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
}
