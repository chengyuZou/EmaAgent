import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { NumberSetting } from '../controls/NumberSetting.js';
import { useSettingValues } from '../useSettingValues.js';

const MAX_ITERATIONS = 'agent.limits.maxIterations';
const MAX_CONCURRENT_SUBAGENTS = 'agent.limits.maxConcurrentSubagents';

export function AgentParameters(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <Loading />;
  if (settings.error) return <Callout variant="danger">Agent 参数读取失败: {settings.error}</Callout>;

  return (
    <SettingsSection icon="i-lucide:bot" title="Agent" description="Agent 循环和子代理并发">
      <SettingsCard>
        <NumberSetting
          title="单轮最大迭代次数"
          hint="根 Agent 与每次子代理执行各自的循环次数上限. 默认 50, 可设为 30-100, 下一轮生效."
          apply={settings.apply(MAX_ITERATIONS)}
          value={requiredNumber(settings.values, MAX_ITERATIONS)}
          unit="次"
          onSave={value => settings.save(MAX_ITERATIONS, value)}
          onReset={() => settings.reset(MAX_ITERATIONS)}
        />
        <NumberSetting 
          title="子代理并发数" 
          hint="同一时间最多运行多少个子代理." 
          apply={settings.apply(MAX_CONCURRENT_SUBAGENTS)} 
          value={requiredNumber(settings.values, MAX_CONCURRENT_SUBAGENTS)} 
          unit="个" 
          onSave={value => settings.save(MAX_CONCURRENT_SUBAGENTS, value)} 
          onReset={() => settings.reset(MAX_CONCURRENT_SUBAGENTS)} 
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function Loading(): JSX.Element {
  return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
}

function requiredNumber(values: ReadonlyMap<string, unknown>, key: string): number {
  const value = values.get(key);
  if (typeof value !== 'number') throw new Error(`参数 ${key} 没有返回数字值`);
  return value;
}
