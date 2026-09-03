import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { ByteSizeSetting } from '../controls/ByteSizeSetting.js';
import { useSettingValues } from '../useSettingValues.js';

const CACHE_MAX_BYTES = 'attachments.cache.maxBytes';

export function AttachmentParameters(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <Loading />;
  if (settings.error) return <Callout variant="danger">附件参数读取失败: {settings.error}</Callout>;

  return (
    <SettingsSection icon="i-lucide:paperclip" title="附件" description="附件缓存设置">
      <SettingsCard>
        <ByteSizeSetting
          title="图片描述缓存"
          hint="Vision 生成的图片文字描述最多占用多少磁盘空间."
          apply={settings.apply(CACHE_MAX_BYTES)}
          value={requiredNumber(settings.values, CACHE_MAX_BYTES)}
          onSave={value => settings.save(CACHE_MAX_BYTES, value)}
          onReset={() => settings.reset(CACHE_MAX_BYTES)}
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
