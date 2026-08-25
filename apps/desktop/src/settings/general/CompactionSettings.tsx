// 上下文压缩设置(context.compaction):开关与触发缓冲直出,预留与熔断折叠;即存,下一轮对话生效。
import { Spinner, Switch } from '@ema-agent/ui';
import type { JSX } from 'react';
import { NumberField } from '../shared/NumberField.js';
import { AdvancedSettings, SaveStateIndicator, SettingItem, SettingsCard, SettingsSection } from '../shared/SettingItem.js';
import { useObjectSetting } from '../shared/useObjectSetting.js';

/** 与 src/context/compaction/types.ts 同形;desktop-ui 不依赖 context 包,本地镜像。 */
interface CompactionValue {
  enabled: boolean;
  bufferTokens: number;
  defaultReservedOutputTokens: number;
  maximumReservedOutputTokens: number;
  keepRecentToolResults: number;
  maximumConsecutiveFailures: number;
}

export function CompactionSettings(): JSX.Element {
  const { value, saveState, update } = useObjectSetting<CompactionValue>('context.compaction');

  return (
    <SettingsSection
      icon="i-solar:minimize-square-3-bold-duotone"
      title="上下文压缩"
      description="对话变长时自动总结旧内容,让长对话不失忆"
      applyNote="下一轮对话生效"
      trailing={<SaveStateIndicator state={saveState} />}
    >
      {value === null ? (
        <div className="flex justify-center py-4"><Spinner size="sm" /></div>
      ) : (
        <SettingsCard>
          <SettingItem
            title="自动压缩"
            hint="开启后,对话接近模型上下文上限时自动总结旧消息,省 Token 但可能丢失细节"
          >
            <Switch checked={value.enabled} onCheckedChange={(enabled) => update({ enabled })} />
          </SettingItem>
          <SettingItem
            title="压缩触发缓冲"
            hint="距离上限还剩多少 token 时开始压缩,越小越晚触发"
          >
            <NumberField value={value.bufferTokens} min={1000} max={64000} unit="tokens" onCommit={(v) => update({ bufferTokens: v })} />
          </SettingItem>
          <AdvancedSettings>
            <SettingItem
              title="默认输出预留"
              hint="为模型回复预留的 token 空间,不能大于最大预留"
            >
              <NumberField value={value.defaultReservedOutputTokens} min={1000} max={64000} unit="tokens" onCommit={(v) => update({ defaultReservedOutputTokens: v })} />
            </SettingItem>
            <SettingItem
              title="最大输出预留"
              hint="输出预留的上限,长回复模型需要更大值"
            >
              <NumberField value={value.maximumReservedOutputTokens} min={1000} max={128000} unit="tokens" onCommit={(v) => update({ maximumReservedOutputTokens: v })} />
            </SettingItem>
            <SettingItem
              title="保留最近工具结果"
              hint="压缩时原样保留最近几条工具输出"
            >
              <NumberField value={value.keepRecentToolResults} min={1} max={32} onCommit={(v) => update({ keepRecentToolResults: v })} />
            </SettingItem>
            <SettingItem
              title="连续失败熔断"
              hint="压缩连续失败几次后暂停自动压缩,防止反复烧 Token"
            >
              <NumberField value={value.maximumConsecutiveFailures} min={1} max={10} onCommit={(v) => update({ maximumConsecutiveFailures: v })} />
            </SettingItem>
          </AdvancedSettings>
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
