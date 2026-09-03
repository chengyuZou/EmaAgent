// 展示内置 Tool 身份并保存逐工具禁用项和后台进程参数.
import { useMemo, type JSX } from 'react';
import { Callout, Spinner, Switch } from '@ema-agent/ui';
import { BuiltinTools } from '@ema-agent/tools/identity';
import { NumberSetting } from '../controls/NumberSetting.js';
import { useSettingValues } from '../useSettingValues.js';
import { SettingsCard, SettingsSection, SettingItem } from '../../shared/SettingItem.js';

const DISABLED_KEY = 'tools.disabled';

export function ToolsSettings(): JSX.Element {
  const settings = useSettingValues();
  const tools = useMemo(() => Object.values(BuiltinTools), []);
  if (settings.loading) return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
  if (settings.error) return <Callout variant="danger">Tools 设置读取失败: {settings.error}</Callout>;
  const disabled = readStringArray(settings.values, DISABLED_KEY);

  const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    const next = enabled ? disabled.filter(item => item !== id) : [...new Set([...disabled, id])];
    await settings.save(DISABLED_KEY, next);
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 pb-10">
      <header>
        <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">Tools</h1>
        <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">管理下一根 Turn 可以看到的内置工具和后台 Shell 行为.</p>
      </header>
      <SettingsSection icon="i-lucide:wrench" title="内置工具" description="身份和分组直接来自 tools 包">
        <SettingsCard>
          {tools.map(tool => {
            const locked = tool.id === BuiltinTools.AskUser.id;
            const enabled = !disabled.includes(tool.id);
            return (
              <SettingItem key={tool.id} title={tool.name} hint={`${tool.variant} · ${tool.id}`} apply={settings.apply(DISABLED_KEY)}>
                <Switch checked={enabled} disabled={locked} label={tool.name} onCheckedChange={value => void setEnabled(tool.id, value)} />
              </SettingItem>
            );
          })}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection icon="i-lucide:terminal-square" title="后台进程" description="Shell 后台任务采用的进程约束">
        <SettingsCard>
          <NumberSetting title="最大并发数" hint="同一时间最多保留多少个后台进程." apply={settings.apply('tools.backgroundProcess.maxConcurrent')} value={readNumber(settings.values, 'tools.backgroundProcess.maxConcurrent')} unit="个" onSave={value => settings.save('tools.backgroundProcess.maxConcurrent', value)} onReset={() => settings.reset('tools.backgroundProcess.maxConcurrent')} />
          <NumberSetting title="最长运行小时" hint="后台进程超过这个时长后由进程管理器停止." apply={settings.apply('tools.backgroundProcess.maxRuntimeHours')} value={readNumber(settings.values, 'tools.backgroundProcess.maxRuntimeHours')} unit="小时" onSave={value => settings.save('tools.backgroundProcess.maxRuntimeHours', value)} onReset={() => settings.reset('tools.backgroundProcess.maxRuntimeHours')} />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

function readStringArray(values: ReadonlyMap<string, unknown>, key: string): string[] {
  const value = values.get(key);
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`设置 ${key} 没有返回字符串数组`);
  return value;
}

function readNumber(values: ReadonlyMap<string, unknown>, key: string): number {
  const value = values.get(key);
  if (typeof value !== 'number') throw new Error(`设置 ${key} 没有返回数字`);
  return value;
}
