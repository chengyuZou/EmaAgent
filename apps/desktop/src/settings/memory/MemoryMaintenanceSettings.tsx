// Memory 维护与存储设置(memory.maintenance / memory.storage):即存,保存后立即生效。
import { Spinner } from '@ema-agent/ui';
import type { JSX } from 'react';
import { NumberField } from '../shared/NumberField.js';
import { SaveStateIndicator, SettingItem, SettingsCard, SettingsSection } from '../shared/SettingItem.js';
import { useObjectSetting } from '../shared/useObjectSetting.js';

/** 与 src/memory/settings.ts 同形;desktop-ui 不依赖该文件的运行时,本地镜像。 */
interface MemoryMaintenanceValue {
  decayAfterDays: number;
  decayAmount: number;
  coldDeleteAfterDays: number;
}

interface MemoryStorageValue {
  maxBytes: number;
}

const MB = 1024 * 1024;

export function MemoryMaintenanceSettings(): JSX.Element {
  const maintenance = useObjectSetting<MemoryMaintenanceValue>('memory.maintenance');
  const storage = useObjectSetting<MemoryStorageValue>('memory.storage');

  return (
    <SettingsSection
      icon="i-solar:leaf-bold-duotone"
      title="维护与存储"
      description="后台自动维护的节奏与记忆占用的磁盘上限,保存后立即生效"
      trailing={(
        <span className="flex items-center gap-1">
          <SaveStateIndicator state={maintenance.saveState} />
          <SaveStateIndicator state={storage.saveState} />
        </span>
      )}
    >
      {maintenance.value === null || storage.value === null ? (
        <div className="flex justify-center py-4"><Spinner size="sm" /></div>
      ) : (
        <SettingsCard>
          <SettingItem
            title="衰减起始天数"
            hint="超过多少天没被提起的记忆开始降低重要度"
          >
            <NumberField
              value={maintenance.value.decayAfterDays}
              min={7}
              max={3650}
              unit="天"
              onCommit={(v) => maintenance.update({ decayAfterDays: v })}
            />
          </SettingItem>
          <SettingItem
            title="每次衰减幅度"
            hint="每次维护降低的重要度,越大忘得越快"
          >
            <NumberField
              value={maintenance.value.decayAmount}
              min={1}
              max={50}
              onCommit={(v) => maintenance.update({ decayAmount: v })}
            />
          </SettingItem>
          <SettingItem
            title="冷记忆删除天数"
            hint="长期零重要度的记忆超过该天数会被自动清理"
          >
            <NumberField
              value={maintenance.value.coldDeleteAfterDays}
              min={30}
              max={3650}
              unit="天"
              onCommit={(v) => maintenance.update({ coldDeleteAfterDays: v })}
            />
          </SettingItem>
          <SettingItem
            title="记忆存储上限"
            hint="超出后自动清理最旧、最冷的记忆与向量"
          >
            <NumberField
              value={Math.round(storage.value.maxBytes / MB)}
              min={64}
              max={8192}
              unit="MB"
              onCommit={(v) => storage.update({ maxBytes: v * MB })}
            />
          </SettingItem>
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
