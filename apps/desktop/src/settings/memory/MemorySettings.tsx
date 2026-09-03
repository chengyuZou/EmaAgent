import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { ByteSizeSetting } from '../parameters/controls/ByteSizeSetting.js';
import { NumberSetting } from '../parameters/controls/NumberSetting.js';
import { useSettingValues } from '../parameters/useSettingValues.js';
import { SettingsCard, SettingsSection } from '../shared/SettingItem.js';

const STORAGE_MAX_BYTES = 'memory.storage.maxBytes';
const WORK_HISTORY_RETENTION_DAYS = 'memory.work.historyRetentionDays';
const RELATIONSHIP_HISTORY_ACTIVE_DAYS = 'memory.relationship.historyActiveDays';
const EXTRACTION_CONCURRENCY = 'memory.jobs.extractionConcurrency';
const HEARTBEAT_SECONDS = 'memory.jobs.heartbeatSeconds';
const CONSOLIDATION_COOLDOWN_HOURS = 'memory.jobs.consolidationCooldownHours';

export function MemorySettings(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
  if (settings.error) return <Callout variant="danger">Memory 参数读取失败: {settings.error}</Callout>;
  const number = (key: string): number => requiredNumber(settings.values, key);

  return (
    <SettingsSection icon="i-lucide:brain" title="Memory 参数" description="Memory 生命周期和后台任务">
      <SettingsCard>
        <ByteSizeSetting title="Memory 存储上限" hint="全部 Memory 文件允许占用的磁盘空间." apply={settings.apply(STORAGE_MAX_BYTES)} value={number(STORAGE_MAX_BYTES)} onSave={value => settings.save(STORAGE_MAX_BYTES, value)} onReset={() => settings.reset(STORAGE_MAX_BYTES)} />
        <NumberSetting title="Work 历史保留天数" hint="按最后修改时间清理 Work 历史文件." apply={settings.apply(WORK_HISTORY_RETENTION_DAYS)} value={number(WORK_HISTORY_RETENTION_DAYS)} unit="天" onSave={value => settings.save(WORK_HISTORY_RETENTION_DAYS, value)} onReset={() => settings.reset(WORK_HISTORY_RETENTION_DAYS)} />
        <NumberSetting title="关系历史活跃天数" hint="每个角色保留最近多少个有记录的活跃日." apply={settings.apply(RELATIONSHIP_HISTORY_ACTIVE_DAYS)} value={number(RELATIONSHIP_HISTORY_ACTIVE_DAYS)} unit="天" onSave={value => settings.save(RELATIONSHIP_HISTORY_ACTIVE_DAYS, value)} onReset={() => settings.reset(RELATIONSHIP_HISTORY_ACTIVE_DAYS)} />
        <NumberSetting title="提取任务并发数" hint="Turn 结束后同时运行的 Memory 提取任务数量." apply={settings.apply(EXTRACTION_CONCURRENCY)} value={number(EXTRACTION_CONCURRENCY)} unit="个" onSave={value => settings.save(EXTRACTION_CONCURRENCY, value)} onReset={() => settings.reset(EXTRACTION_CONCURRENCY)} />
        <NumberSetting title="任务心跳秒数" hint="整合和维护任务报告所有权的间隔秒数." apply={settings.apply(HEARTBEAT_SECONDS)} value={number(HEARTBEAT_SECONDS)} unit="秒" onSave={value => settings.save(HEARTBEAT_SECONDS, value)} onReset={() => settings.reset(HEARTBEAT_SECONDS)} />
        <NumberSetting title="整合冷却小时" hint="同一轨两次自动整合之间至少等待多少小时, 0 表示关闭冷却." apply={settings.apply(CONSOLIDATION_COOLDOWN_HOURS)} value={number(CONSOLIDATION_COOLDOWN_HOURS)} unit="小时" onSave={value => settings.save(CONSOLIDATION_COOLDOWN_HOURS, value)} onReset={() => settings.reset(CONSOLIDATION_COOLDOWN_HOURS)} />
      </SettingsCard>
    </SettingsSection>
  );
}

function requiredNumber(values: ReadonlyMap<string, unknown>, key: string): number {
  const value = values.get(key);
  if (typeof value !== 'number') throw new Error(`参数 ${key} 没有返回数字值`);
  return value;
}
