import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { NumberSetting } from '../controls/NumberSetting.js';
import { SwitchSetting } from '../controls/SwitchSetting.js';
import { useSettingValues } from '../useSettingValues.js';

const ENABLED = 'vishotCapture.enabled';
const INTERVAL = 'vishotCapture.intervalSeconds';

export function VishotCaptureParameters(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
  if (settings.error) return <Callout variant="danger">屏幕捕获设置读取失败: {settings.error}</Callout>;
  const enabled = settings.values.get(ENABLED);
  const interval = settings.values.get(INTERVAL);
  if (typeof enabled !== 'boolean' || typeof interval !== 'number') {
    return <Callout variant="danger">屏幕捕获设置返回值不完整.</Callout>;
  }

  return (
    <SettingsSection icon="i-lucide:scan" title="自动屏幕捕获" description="跟随当前打开的聊天, 只在会话和消息队列都空闲时提交截图.">
      <Callout variant="info">
        开启后, 截图会保存为聊天附件, 并交给该会话的模型读取. 请留意屏幕上的私人信息.
        macOS 和 Linux/X11 为测试版, Wayland 暂不支持. 手动调用 Capture 工具不受此开关控制.
      </Callout>
      <SettingsCard>
        <SwitchSetting
          title="自动捕获屏幕"
          hint="需要系统屏幕录制权限, 并且当前模型支持图片或已配置 Vision. 停止生成不会关闭此开关."
          apply={settings.apply(ENABLED)}
          value={enabled}
          onSave={value => settings.save(ENABLED, value)}
          onReset={() => settings.reset(ENABLED)}
        />
        <NumberSetting
          title="捕获间隔"
          hint="10-86400 秒. 开启或切换聊天后等待一个完整间隔再捕获; 忙碌时跳过."
          apply={settings.apply(INTERVAL)}
          value={interval}
          unit="秒"
          onSave={value => settings.save(INTERVAL, value)}
          onReset={() => settings.reset(INTERVAL)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
