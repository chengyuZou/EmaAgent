import { narrativeQueryModeSetting } from '@ema-agent/server/settings';
import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { SelectSetting } from '../../shared/controls/SelectSetting.js';
import { useSettingValues } from '../../shared/useSettingValues.js';

export function NarrativeParameters(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) {
    return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
  }
  if (settings.error) {
    return <Callout variant="danger">Narrative 参数读取失败: {settings.error}</Callout>;
  }
  const mode = settings.get(narrativeQueryModeSetting);

  return (
    <SettingsSection icon="i-lucide:book-open" title="Narrative" description="剧情检索算法; 工具的启用和禁用在工具设置中选择">
      <SettingsCard>
        <SelectSetting
          title="剧情检索模式"
          hint="自动允许模型选择算法, 未指定时使用混合检索. 其他选项固定每次查询使用的算法, 不会自动发起检索."
          apply={settings.apply(narrativeQueryModeSetting)}
          value={mode}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'local', label: '局部' },
            { value: 'global', label: '全局' },
            { value: 'hybrid', label: '混合' },
            { value: 'naive', label: '直接检索' },
            { value: 'mix', label: 'Mix' },
          ]}
          onSave={value => settings.save(narrativeQueryModeSetting, narrativeQueryModeSetting.schema.parse(value))}
          onReset={() => settings.reset(narrativeQueryModeSetting)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
