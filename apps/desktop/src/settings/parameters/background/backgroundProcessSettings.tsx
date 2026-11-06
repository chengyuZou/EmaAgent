import {
  maxConcurrentBackgroundSetting,
  maxRuntimeHoursBackgroundSetting,
  minAvailableMemorySetting,
} from '@ema-agent/server/settings';
import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { PageHeader } from '../../shared/PageHeader.js';
import { SettingsCard } from '../../shared/SettingItem.js';
import { NumberSetting } from '../../shared/controls/NumberSetting.js';
import { ByteSizeSetting } from '../../shared/controls/ByteSizeSetting.js';
import { useSettingValues } from '../../shared/useSettingValues.js';

export function BackgroundProcessSettings(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Spinner size="md" />
      </div>
    );
  }
  if (settings.error) {
    return <Callout variant="danger">后台进程设置读取失败: {settings.error}</Callout>;
  }

  return (
    <div className="flex w-full flex-col gap-8 pb-10">
      <PageHeader title="后台进程" description="Shell 后台任务的进程约束, 以及全部 Shell 命令的内存预检." />
      <SettingsCard>
        <ByteSizeSetting
          title="命令启动所需可用内存"
          hint="Windows, macOS 和 Linux 均检查. 低于此值时 Bash/PowerShell 不启动, 后台排队的命令也会重查. 0 关闭检查. 不限制启动后的内存增长, 不影响查看和停止进程."
          apply={settings.apply(minAvailableMemorySetting)}
          value={settings.get(minAvailableMemorySetting)}
          onSave={value => settings.save(minAvailableMemorySetting, value)}
          onReset={() => settings.reset(minAvailableMemorySetting)}
        />
        <NumberSetting
          title="显式后台命令并发数"
          hint={`所有 Session 共用, 默认 ${maxConcurrentBackgroundSetting.defaultValue}. 满额后按提交顺序等待, 不包含普通命令转后台后的进程.`}
          apply={settings.apply(maxConcurrentBackgroundSetting)}
          value={settings.get(maxConcurrentBackgroundSetting)}
          unit="个"
          onSave={value => settings.save(maxConcurrentBackgroundSetting, value)}
          onReset={() => settings.reset(maxConcurrentBackgroundSetting)}
        />
        <NumberSetting
          title="最长运行小时"
          hint="Bash 和 PowerShell 从进程启动起计算, 包含前台等待时间. 超过上限会停止; 修改只影响新提交的命令."
          apply={settings.apply(maxRuntimeHoursBackgroundSetting)}
          value={settings.get(maxRuntimeHoursBackgroundSetting)}
          unit="小时"
          onSave={value => settings.save(maxRuntimeHoursBackgroundSetting, value)}
          onReset={() => settings.reset(maxRuntimeHoursBackgroundSetting)}
        />
      </SettingsCard>
    </div>
  );
}
