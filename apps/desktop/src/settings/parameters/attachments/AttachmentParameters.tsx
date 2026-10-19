import { attachmentCacheMaxBytesSetting } from '@ema-agent/server/settings';
import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { ByteSizeSetting } from '../../shared/controls/ByteSizeSetting.js';
import { useSettingValues } from '../../shared/useSettingValues.js';

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
          apply={settings.apply(attachmentCacheMaxBytesSetting)}
          value={settings.get(attachmentCacheMaxBytesSetting)}
          onSave={value => settings.save(attachmentCacheMaxBytesSetting, value)}
          onReset={() => settings.reset(attachmentCacheMaxBytesSetting)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function Loading(): JSX.Element {
  return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
}
