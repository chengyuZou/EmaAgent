// 编辑 Skill 来源级开关, 逐技能开关仍由已安装列表负责.
import { useEffect, useState, type JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { skillsApi, type SkillProjectSourceList } from '../../api/skills.js';
import { MultiSelectSetting } from '../parameters/controls/MultiSelectSetting.js';
import { SwitchSetting } from '../parameters/controls/SwitchSetting.js';
import { useSettingValues } from '../parameters/useSettingValues.js';
import { SettingsCard, SettingsSection } from '../shared/SettingItem.js';

const BUILTIN_KEY = 'skill.builtinEnabled';
const PROJECT_SOURCES_KEY = 'skill.disabledProjectSources';

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

  const builtinEnabled = readBoolean(settings.values, BUILTIN_KEY);
  const disabledSourceIds = readDisabledSources(settings.values, PROJECT_SOURCES_KEY);
  const enabledSourceIds = sources.map(source => source.sourceId).filter(id => !disabledSourceIds.includes(id));

  return (
    <SettingsSection icon="i-lucide:blocks" title="技能来源" description="控制内置技能和工作区生态目录">
      <SettingsCard>
        <SwitchSetting
          title="内置技能"
          hint="关闭后不再把 Ema 自带的 Skills 提供给下一根 Turn."
          apply={settings.apply(BUILTIN_KEY)}
          value={builtinEnabled}
          onSave={value => settings.save(BUILTIN_KEY, value)}
          onReset={() => settings.reset(BUILTIN_KEY)}
        />
        <MultiSelectSetting
          title="工作区技能来源"
          hint="扫描所选生态在当前工作区里的 Skills 目录."
          apply={settings.apply(PROJECT_SOURCES_KEY)}
          value={enabledSourceIds}
          options={sources.map(source => ({ value: source.sourceId, label: source.relativeDir }))}
          onSave={enabled => settings.save(PROJECT_SOURCES_KEY, {
            disabledSourceIds: sources.map(source => source.sourceId).filter(id => !enabled.includes(id)),
          })}
          onReset={() => settings.reset(PROJECT_SOURCES_KEY)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function readBoolean(values: ReadonlyMap<string, unknown>, key: string): boolean {
  const value = values.get(key);
  if (typeof value !== 'boolean') throw new Error(`设置 ${key} 没有返回 boolean`);
  return value;
}

function readDisabledSources(values: ReadonlyMap<string, unknown>, key: string): string[] {
  const value = values.get(key);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`设置 ${key} 没有返回来源对象`);
  const ids = (value as { disabledSourceIds?: unknown }).disabledSourceIds;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error(`设置 ${key} 没有返回来源列表`);
  return ids;
}
