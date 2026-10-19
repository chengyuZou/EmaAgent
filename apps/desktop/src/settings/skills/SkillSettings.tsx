import { disabledProjectSourcesSetting } from '@ema-agent/server/settings';
import { useEffect, useState, type JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { skillsApi, type SkillProjectSourceList } from '../../api/skills.js';
import { MultiSelectSetting } from '../shared/controls/MultiSelectSetting.js';
import { useSettingValues } from '../shared/useSettingValues.js';
import { SettingsCard, SettingsSection } from '../shared/SettingItem.js';

export function SkillSettings(): JSX.Element {
  const settings = useSettingValues();
  const [sources, setSources] = useState<SkillProjectSourceList['items'] | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  useEffect(() => {
    void skillsApi.listProjectSources()
      .then(result => setSources(result.items))
      .catch(cause => setSourceError(cause instanceof Error ? cause.message : '工作区技能来源读取失败'));
  }, []);
  if (settings.loading || sources === null && sourceError === null) return <div className="flex h-40 items-center justify-center"><Spinner size="md" /></div>;
  if (settings.error) return <Callout variant="danger">Skill 设置读取失败: {settings.error}</Callout>;
  if (sourceError) return <Callout variant="danger">工作区技能来源读取失败: {sourceError}</Callout>;
  if (!sources) throw new Error('工作区技能来源没有返回');

  const disabledSourceIds = settings.get(disabledProjectSourcesSetting).disabledSourceIds;
  const enabledSourceIds = sources.map(source => source.sourceId).filter(id => !disabledSourceIds.includes(id));

  return (
    <SettingsSection icon="i-lucide:blocks" title="技能来源" description="控制各会话工作区里的项目技能生态目录;内置与用户技能的逐技能开关在已安装列表">
      <SettingsCard>
        <MultiSelectSetting
          title="工作区技能来源"
          hint="扫描所选生态在当前工作区里的 Skills 目录."
          apply={settings.apply(disabledProjectSourcesSetting)}
          value={enabledSourceIds}
          options={sources.map(source => ({ value: source.sourceId, label: source.relativeDir }))}
          onSave={enabled => settings.save(disabledProjectSourcesSetting, {
            disabledSourceIds: sources.map(source => source.sourceId).filter(id => !enabled.includes(id)),
          })}
          onReset={() => settings.reset(disabledProjectSourcesSetting)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
