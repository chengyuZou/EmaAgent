import {
  disabledToolsSetting,
  maxConcurrentBackgroundSetting,
  maxRuntimeHoursBackgroundSetting,
} from '@ema-agent/server/settings';
import { useMemo, type JSX } from 'react';
import { Callout, Spinner, Switch } from '@ema-agent/ui';
import { BuiltinTools } from '@ema-agent/tools/identity';
import { NarrativeToolStatus } from '../../../chat/input/narrativeToolNotice.js';
import { NumberSetting } from '../../shared/controls/NumberSetting.js';
import { useSettingValues } from '../../shared/useSettingValues.js';
import { SettingsCard, SettingsSection, SettingItem } from '../../shared/SettingItem.js';

export function ToolsSettings(): JSX.Element {
  const settings = useSettingValues();
  const tools = useMemo(() => Object.values(BuiltinTools), []);
  if (settings.loading) return (
    <div className="flex h-48 items-center justify-center">
      <Spinner size="md" />
    </div>
  );

  if (settings.error) return (
    <Callout variant="danger">
      Tools 设置读取失败: {settings.error}
    </Callout>
  );

  const disabled = settings.get(disabledToolsSetting);

  const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    const next = enabled ? disabled.filter(item => item !== id) : [...new Set([...disabled, id])];
    await settings.save(disabledToolsSetting, next);
  };

  return (
    <div className="flex w-full flex-col gap-8 pb-10">
      <header>
        <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">Tools</h1>
        <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">管理下一次执行可以看到的内置工具和后台 Shell 行为.</p>
      </header>
      <SettingsSection icon="i-lucide:wrench" title="内置工具" description="身份和分组直接来自 tools 包">
        <SettingsCard>
          {tools.map(tool => {
            const locked = tool.id === BuiltinTools.AskUser.id;
            const enabled = !disabled.includes(tool.id);
            return (
              <div key={tool.id}>
                <SettingItem
                  title={tool.name}
                  hint={tool.id === BuiltinTools.NarrativeSearch.id
                    ? '仅用于游戏剧情角色. 开关保留使用偏好, 实际是否提供由当前角色和模型配置决定.'
                    : `${tool.variant} · ${tool.id}`}
                  apply={settings.apply(disabledToolsSetting)}
                >
                  <Switch
                    checked={enabled}
                    disabled={locked}
                    label={tool.name}
                    onCheckedChange={value => void setEnabled(tool.id, value)}
                  />
                </SettingItem>
                {tool.id === BuiltinTools.NarrativeSearch.id && (
                  <NarrativeToolStatus enabled={enabled} />
                )}
              </div>
            );
          })}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection icon="i-lucide:terminal-square" title="后台进程" description="Shell 后台任务采用的进程约束">
        <SettingsCard>
          <NumberSetting
            title="最大并发数"
            hint="同一时间最多保留多少个后台进程."
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
      </SettingsSection>
    </div>
  );
}
