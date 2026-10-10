import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { SelectSetting } from '../controls/SelectSetting.js';
import { useSettingValues } from '../useSettingValues.js';

const QUERY_MODE = 'narrative.queryMode';

export function NarrativeParameters(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) {
    return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
  }
  if (settings.error) {
    return <Callout variant="danger">Narrative 参数读取失败: {settings.error}</Callout>;
  }
  const mode = settings.values.get(QUERY_MODE);
  if (typeof mode !== 'string') {
    throw new Error('Narrative 检索模式没有返回字符串值');
  }

  return (
    <SettingsSection icon="i-lucide:book-open" title="Narrative" description="剧情检索算法; 工具的启用和禁用在工具设置中选择">
      <SettingsCard>
        <SelectSetting
          title="剧情检索模式"
          hint="自动允许模型选择算法, 未指定时使用混合检索. 其他选项固定每次查询使用的算法, 不会自动发起检索."
          apply={settings.apply(QUERY_MODE)}
          value={mode}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'local', label: '局部' },
            { value: 'global', label: '全局' },
            { value: 'hybrid', label: '混合' },
            { value: 'naive', label: '直接检索' },
            { value: 'mix', label: 'Mix' },
          ]}
          onSave={value => settings.save(QUERY_MODE, value)}
          onReset={() => settings.reset(QUERY_MODE)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
