// 附件接收上限设置(attachments.limits):数量与图片大小直出,分辨率与缓存折叠;即存,下一轮对话生效。
import { Spinner } from '@ema-agent/ui';
import type { JSX } from 'react';
import { NumberField } from '../shared/NumberField.js';
import { AdvancedSettings, SaveStateIndicator, SettingItem, SettingsCard, SettingsSection } from '../shared/SettingItem.js';
import { useObjectSetting } from '../shared/useObjectSetting.js';

/** 与 src/attachment/settings.ts 同形;desktop-ui 不依赖 attachment 包,本地镜像。 */
interface AttachmentLimitsValue {
  maxImagesPerTurn: number;
  maxFilesPerTurn: number;
  maxImageBytes: number;
  maxImageLongEdge: number;
  derivationCacheBytes: number;
}

const MB = 1024 * 1024;

export function AttachmentLimitsSettings(): JSX.Element {
  const { value, saveState, update } = useObjectSetting<AttachmentLimitsValue>('attachments.limits');

  return (
    <SettingsSection
      icon="i-lucide:paperclip"
      title="附件"
      description="对话中接收图片与文件的安全范围"
      applyNote="下一轮对话生效"
      trailing={<SaveStateIndicator state={saveState} />}
    >
      {value === null ? (
        <div className="flex justify-center py-4"><Spinner size="sm" /></div>
      ) : (
        <SettingsCard>
          <SettingItem
            title="每轮图片数"
            hint="一次对话最多附带几张图片"
          >
            <NumberField value={value.maxImagesPerTurn} min={1} max={10} onCommit={(v) => update({ maxImagesPerTurn: v })} />
          </SettingItem>
          <SettingItem
            title="每轮文件数"
            hint="一次对话最多附带几个文件"
          >
            <NumberField value={value.maxFilesPerTurn} min={1} max={20} onCommit={(v) => update({ maxFilesPerTurn: v })} />
          </SettingItem>
          <SettingItem
            title="单张图片大小"
            hint="超过会被拒收"
          >
            <NumberField
              value={Math.round(value.maxImageBytes / MB)}
              min={1}
              max={20}
              unit="MB"
              onCommit={(v) => update({ maxImageBytes: v * MB })}
            />
          </SettingItem>
          <AdvancedSettings>
            <SettingItem
              title="图片长边上限"
              hint="超过会等比缩小,影响清晰度与识别成本"
            >
              <NumberField value={value.maxImageLongEdge} min={512} max={2048} unit="px" onCommit={(v) => update({ maxImageLongEdge: v })} />
            </SettingItem>
            <SettingItem
              title="派生缓存上限"
              hint="图片处理缓存占用的磁盘上限"
            >
              <NumberField
                value={Math.round(value.derivationCacheBytes / MB)}
                min={64}
                max={2048}
                unit="MB"
                onCommit={(v) => update({ derivationCacheBytes: v * MB })}
              />
            </SettingItem>
          </AdvancedSettings>
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
