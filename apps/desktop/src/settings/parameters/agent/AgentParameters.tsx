import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { NumberSetting } from '../controls/NumberSetting.js';
import { useSettingValues } from '../useSettingValues.js';

const CHAT_MAX_ITERATIONS = 'agent.limits.chatMaxIterations';
const WORK_MAX_ITERATIONS = 'agent.limits.workMaxIterations';
const MAX_CONCURRENT_SUBAGENTS = 'agent.limits.maxConcurrentSubagents';

export function AgentParameters(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <Loading />;
  if (settings.error) return <Callout variant="danger">Agent 参数读取失败: {settings.error}</Callout>;

  return (
    <SettingsSection icon="i-lucide:bot" title="Agent" description="Agent 循环和子代理并发">
      <SettingsCard>
        <NumberSetting title="Chat 最大迭代次数" hint="Chat 模式单个 Turn 最多调用模型多少轮." apply={settings.apply(CHAT_MAX_ITERATIONS)} value={requiredNumber(settings.values, CHAT_MAX_ITERATIONS)} unit="轮" onSave={value => settings.save(CHAT_MAX_ITERATIONS, value)} onReset={() => settings.reset(CHAT_MAX_ITERATIONS)} />
        <NumberSetting title="Work 最大迭代次数" hint="Work 模式单个 Turn 最多调用模型多少轮." apply={settings.apply(WORK_MAX_ITERATIONS)} value={requiredNumber(settings.values, WORK_MAX_ITERATIONS)} unit="轮" onSave={value => settings.save(WORK_MAX_ITERATIONS, value)} onReset={() => settings.reset(WORK_MAX_ITERATIONS)} />
        <NumberSetting title="子代理并发数" hint="同一时间最多运行多少个子代理." apply={settings.apply(MAX_CONCURRENT_SUBAGENTS)} value={requiredNumber(settings.values, MAX_CONCURRENT_SUBAGENTS)} unit="个" onSave={value => settings.save(MAX_CONCURRENT_SUBAGENTS, value)} onReset={() => settings.reset(MAX_CONCURRENT_SUBAGENTS)} />
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
