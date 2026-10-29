import type { JSX } from 'react';
import { vishotCaptureEnabledSetting, vishotCaptureIntervalSecondsSetting } from '@ema-agent/server/settings';
import { Callout, Spinner } from '@ema-agent/ui';
import { SettingsCard, SettingsSection } from '../shared/SettingItem.js';
import { NumberSetting } from '../shared/controls/NumberSetting.js';
import { SwitchSetting } from '../shared/controls/SwitchSetting.js';
import { useSettingValues } from '../shared/useSettingValues.js';
import { PageHeader } from '../shared/PageHeader.js';

export function ComputerUseSettings(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Spinner size="md" />
      </div>
    );
  }
  if (settings.error) return <Callout variant="danger">电脑操控设置读取失败: {settings.error}</Callout>;
  const enabled = settings.get(vishotCaptureEnabledSetting);
  const interval = settings.get(vishotCaptureIntervalSecondsSetting);

  return (
    <div className="mx-auto flex w-full flex-col gap-8 pb-10">
      <PageHeader title="电脑操控" description="窗口观察, 键鼠操作与自动屏幕捕获" />
      <SettingsSection
        icon="i-lucide:mouse-pointer-2"
        title="电脑操控"
        description="Windows 主 Agent 可观察窗口, 使用键鼠和可用控件完成操作."
      >
        <Callout variant="info">
          由 Agent 调用 ObserveWindow 启动, 可选择允许本次或本会话允许.
          电脑操控仅在当前 Turn 内有效, Turn 结束后自动结束.
          按 Esc 或点击提示条的结束按钮可结束操控, 对话仍可继续.
          用户操作目标窗口后, Agent 需要重新观察再继续操作.
          当前仅支持 Windows, 子代理不使用电脑操控工具.
        </Callout>
      </SettingsSection>
      <SettingsSection
        icon="i-lucide:scan"
        title="自动屏幕捕获"
        description="跟随当前打开的聊天, 只在会话和消息队列都空闲时提交截图."
      >
        <Callout variant="info">
          开启后, 截图会保存为聊天附件, 并交给该会话的模型读取. 请留意屏幕上的私人信息.
          macOS 和 Linux/X11 为测试版, Wayland 暂不支持. 手动调用 Capture 工具不受此开关控制.
          自动捕获会跳过与上次成功提交完全相同的画面. 电脑操控期间, 自动捕获暂时停止, 控制结束后恢复.
        </Callout>
        <SettingsCard>
          <SwitchSetting
            title="自动捕获屏幕"
            hint="需要系统屏幕录制权限, 并且当前模型支持图片或已配置 Vision. 停止生成不会关闭此开关."
            apply={settings.apply(vishotCaptureEnabledSetting)}
            value={enabled}
            onSave={value => settings.save(vishotCaptureEnabledSetting, value)}
            onReset={() => settings.reset(vishotCaptureEnabledSetting)}
          />
          <NumberSetting
            title="捕获间隔"
            hint="10-86400 秒. 开启或切换聊天后等待一个完整间隔再捕获; 忙碌时跳过."
            apply={settings.apply(vishotCaptureIntervalSecondsSetting)}
            value={interval}
            unit="秒"
            onSave={value => settings.save(vishotCaptureIntervalSecondsSetting, value)}
            onReset={() => settings.reset(vishotCaptureIntervalSecondsSetting)}
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
