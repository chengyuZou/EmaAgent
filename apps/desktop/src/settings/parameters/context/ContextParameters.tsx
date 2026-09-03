import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { NumberSetting } from '../controls/NumberSetting.js';
import { PercentSetting } from '../controls/PercentSetting.js';
import { useSettingValues } from '../useSettingValues.js';

const BUFFER_RATIO = 'context.compact.bufferRatio';
const OUTPUT_TOKENS = 'context.compact.outputTokens';
const KEEP_RECENT_TOOL_RESULTS = 'context.compact.keepRecentToolResults';
const MAXIMUM_CONSECUTIVE_FAILURES = 'context.compact.maximumConsecutiveFailures';
const RETAIN_RATIO = 'context.compact.retainRatio';
const MANUAL_MIN_RATIO = 'context.compact.manualMinRatio';

export function ContextParameters(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <Loading />;
  if (settings.error) return <Callout variant="danger">上下文参数读取失败: {settings.error}</Callout>;
  const number = (key: string): number => requiredNumber(settings.values, key);

  return (
    <SettingsSection icon="i-lucide:gauge" title="上下文" description="自动压缩与手动压缩">
      <SettingsCard>
        <PercentSetting title="自动压缩缓冲" hint="为模型输出和工具结果预留的上下文比例." apply={settings.apply(BUFFER_RATIO)} value={number(BUFFER_RATIO)} onSave={value => settings.save(BUFFER_RATIO, value)} onReset={() => settings.reset(BUFFER_RATIO)} />
        <NumberSetting title="摘要输出 Token" hint="Macro 摘要调用允许生成的最大 Token 数." apply={settings.apply(OUTPUT_TOKENS)} value={number(OUTPUT_TOKENS)} unit="Token" onSave={value => settings.save(OUTPUT_TOKENS, value)} onReset={() => settings.reset(OUTPUT_TOKENS)} />
        <NumberSetting title="保留最近工具结果" hint="压缩后原样保留多少条最近工具结果." apply={settings.apply(KEEP_RECENT_TOOL_RESULTS)} value={number(KEEP_RECENT_TOOL_RESULTS)} unit="条" onSave={value => settings.save(KEEP_RECENT_TOOL_RESULTS, value)} onReset={() => settings.reset(KEEP_RECENT_TOOL_RESULTS)} />
        <NumberSetting title="连续失败熔断" hint="连续压缩失败多少次后停止本轮自动压缩." apply={settings.apply(MAXIMUM_CONSECUTIVE_FAILURES)} value={number(MAXIMUM_CONSECUTIVE_FAILURES)} unit="次" onSave={value => settings.save(MAXIMUM_CONSECUTIVE_FAILURES, value)} onReset={() => settings.reset(MAXIMUM_CONSECUTIVE_FAILURES)} />
        <PercentSetting title="近期原文保留" hint="压缩时计划保留的近期原文比例." apply={settings.apply(RETAIN_RATIO)} value={number(RETAIN_RATIO)} onSave={value => settings.save(RETAIN_RATIO, value)} onReset={() => settings.reset(RETAIN_RATIO)} />
        <PercentSetting title="手动压缩下限" hint="低于这个占用比例时拒绝无意义的手动压缩." apply={settings.apply(MANUAL_MIN_RATIO)} value={number(MANUAL_MIN_RATIO)} onSave={value => settings.save(MANUAL_MIN_RATIO, value)} onReset={() => settings.reset(MANUAL_MIN_RATIO)} />
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
