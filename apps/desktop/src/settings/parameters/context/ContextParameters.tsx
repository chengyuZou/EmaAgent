import {
  compactBufferRatioSetting,
  compactKeepRecentToolResultsSetting,
  compactMaximumConsecutiveFailuresSetting,
  compactRetainRatioSetting,
  compactManualMinRatioSetting,
} from '@ema-agent/server/settings';
import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { NumberSetting } from '../../shared/controls/NumberSetting.js';
import { PercentSetting } from '../../shared/controls/PercentSetting.js';
import { useSettingValues } from '../../shared/useSettingValues.js';

export function ContextParameters(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <Loading />;
  if (settings.error) return <Callout variant="danger">上下文参数读取失败: {settings.error}</Callout>;

  return (
    <SettingsSection icon="i-lucide:gauge" title="上下文" description="自动压缩与手动压缩">
      <SettingsCard>
        <PercentSetting
          title="自动压缩缓冲"
          hint="为模型输出和工具结果预留的上下文比例."
          apply={settings.apply(compactBufferRatioSetting)}
          value={settings.get(compactBufferRatioSetting)}
          onSave={value => settings.save(compactBufferRatioSetting, value)}
          onReset={() => settings.reset(compactBufferRatioSetting)}
        />
        <NumberSetting
          title="保留最近工具结果"
          hint="压缩后原样保留多少条最近工具结果."
          apply={settings.apply(compactKeepRecentToolResultsSetting)}
          value={settings.get(compactKeepRecentToolResultsSetting)}
          unit="条"
          onSave={value => settings.save(compactKeepRecentToolResultsSetting, value)}
          onReset={() => settings.reset(compactKeepRecentToolResultsSetting)}
        />
        <NumberSetting
          title="连续失败熔断"
          hint="连续压缩失败多少次后停止本轮自动压缩."
          apply={settings.apply(compactMaximumConsecutiveFailuresSetting)}
          value={settings.get(compactMaximumConsecutiveFailuresSetting)}
          unit="次" onSave={value => settings.save(compactMaximumConsecutiveFailuresSetting, value)}
          onReset={() => settings.reset(compactMaximumConsecutiveFailuresSetting)}
        />
        <PercentSetting
          title="近期原文保留"
          hint="压缩时计划保留的近期原文比例."
          apply={settings.apply(compactRetainRatioSetting)}
          value={settings.get(compactRetainRatioSetting)}
          onSave={value => settings.save(compactRetainRatioSetting, value)}
          onReset={() => settings.reset(compactRetainRatioSetting)}
        />
        <PercentSetting
          title="手动压缩下限"
          hint="低于这个占用比例时拒绝无意义的手动压缩."
          apply={settings.apply(compactManualMinRatioSetting)}
          value={settings.get(compactManualMinRatioSetting)}
          onSave={value => settings.save(compactManualMinRatioSetting, value)}
          onReset={() => settings.reset(compactManualMinRatioSetting)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function Loading(): JSX.Element {
  return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
}
