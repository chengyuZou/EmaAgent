import { maxIterationsSetting, maxConcurrentSubagentsSetting } from '@ema-agent/server/settings';
import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { NumberSetting } from '../../shared/controls/NumberSetting.js';
import { useSettingValues } from '../../shared/useSettingValues.js';

export function AgentParameters(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <Loading />;
  if (settings.error) return <Callout variant="danger">Agent 参数读取失败: {settings.error}</Callout>;

  return (
    <SettingsSection icon="i-lucide:bot" title="Agent" description="Agent 循环和子代理并发">
      <SettingsCard>
        <NumberSetting
          title="单轮最大迭代次数"
          hint={`主 Agent 与每次子代理执行各自的循环次数上限. 默认 ${maxIterationsSetting.defaultValue}, 下一次 Turn 生效.`}
          apply={settings.apply(maxIterationsSetting)}
          value={settings.get(maxIterationsSetting)}
          unit="次"
          onSave={value => settings.save(maxIterationsSetting, value)}
          onReset={() => settings.reset(maxIterationsSetting)}
        />
        <NumberSetting
          title="子代理并发数"
          hint="同一时间最多运行多少个子代理."
          apply={settings.apply(maxConcurrentSubagentsSetting)}
          value={settings.get(maxConcurrentSubagentsSetting)}
          unit="个"
          onSave={value => settings.save(maxConcurrentSubagentsSetting, value)}
          onReset={() => settings.reset(maxConcurrentSubagentsSetting)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function Loading(): JSX.Element {
  return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
}
