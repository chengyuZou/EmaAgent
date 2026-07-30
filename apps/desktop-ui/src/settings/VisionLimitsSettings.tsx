// Vision 请求上限设置(vision.limits):图片数与超时直出,体积与并发折叠;即存,立即生效。
import { Spinner } from '@ema-agent/ui';
import type { JSX } from 'react';
import { NumberField } from './NumberField.js';
import { AdvancedSettings, SaveStateIndicator, SettingItem, SettingsCard, SettingsSection } from './SettingItem.js';
import { useObjectSetting } from './useObjectSetting.js';

/** 与 src/vision/types.ts 的 VisionLimits 同形;desktop-ui 不依赖 vision 包,本地镜像。 */
interface VisionLimitsValue {
  maxImages: number;
  maxBytesPerImage: number;
  maxTotalBytes: number;
  maxConcurrentGlobal: number;
  maxConcurrentPerProvider: number;
  maxQueuedRequests: number;
  timeoutMs: number;
}

const MB = 1024 * 1024;

export function VisionLimitsSettings(): JSX.Element {
  const { value, saveState, update } = useObjectSetting<VisionLimitsValue>('vision.limits');

  return (
    <SettingsSection
      icon="i-solar:eye-bold-duotone"
      title="视觉"
      description="看图请求的体积、并发与超时上限,保存后立即生效"
      trailing={<SaveStateIndicator state={saveState} />}
    >
      {value === null ? (
        <div className="flex justify-center py-4"><Spinner size="sm" /></div>
      ) : (
        <SettingsCard>
          <SettingItem
            title="单次图片数"
            hint="一次看图请求最多携带几张图片"
          >
            <NumberField value={value.maxImages} min={1} max={8} onCommit={(v) => update({ maxImages: v })} />
          </SettingItem>
          <SettingItem
            title="请求超时"
            hint="看图请求超过该时间未响应则取消"
          >
            <NumberField
              value={Math.round(value.timeoutMs / 1000)}
              min={5}
              max={300}
              unit="秒"
              onCommit={(v) => update({ timeoutMs: v * 1000 })}
            />
          </SettingItem>
          <AdvancedSettings>
            <SettingItem
              title="单张图片体积"
              hint="超过会被拒收"
            >
              <NumberField
                value={Math.round(value.maxBytesPerImage / MB)}
                min={1}
                max={20}
                unit="MB"
                onCommit={(v) => update({ maxBytesPerImage: v * MB })}
              />
            </SettingItem>
            <SettingItem
              title="单次总体积"
              hint="一次请求所有图片合计的上限,不能小于单张上限"
            >
              <NumberField
                value={Math.round(value.maxTotalBytes / MB)}
                min={1}
                max={40}
                unit="MB"
                onCommit={(v) => update({ maxTotalBytes: v * MB })}
              />
            </SettingItem>
            <SettingItem
              title="全局并发"
              hint="同时进行的看图请求总数"
            >
              <NumberField value={value.maxConcurrentGlobal} min={1} max={8} onCommit={(v) => update({ maxConcurrentGlobal: v })} />
            </SettingItem>
            <SettingItem
              title="单服务并发"
              hint="同一个模型服务同时进行的看图请求数,不能大于全局并发"
            >
              <NumberField value={value.maxConcurrentPerProvider} min={1} max={4} onCommit={(v) => update({ maxConcurrentPerProvider: v })} />
            </SettingItem>
            <SettingItem
              title="排队上限"
              hint="超过并发的请求排队等待的最大数量,0 表示不排队"
            >
              <NumberField value={value.maxQueuedRequests} min={0} max={128} onCommit={(v) => update({ maxQueuedRequests: v })} />
            </SettingItem>
          </AdvancedSettings>
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
