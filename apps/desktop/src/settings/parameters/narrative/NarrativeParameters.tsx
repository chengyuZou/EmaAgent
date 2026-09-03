import { useEffect, useState, type JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { tauriBridge } from '../../../lib/tauri-bridge.js';
import { SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { SelectSetting } from '../controls/SelectSetting.js';
import { SwitchSetting } from '../controls/SwitchSetting.js';
import { useSettingValues } from '../useSettingValues.js';

const QUERY_MODE = 'narrative.queryMode';

export function NarrativeParameters(): JSX.Element {
  const settings = useSettingValues();
  const [startOnLaunch, setStartOnLaunch] = useState<boolean | null>(null);
  const [desktopError, setDesktopError] = useState<string | null>(null);

  useEffect(() => {
    void tauriBridge.getStartNarrativeOnLaunch()
      .then(setStartOnLaunch)
      .catch(cause => setDesktopError(cause instanceof Error ? cause.message : 'Narrative 启动参数读取失败'));
  }, []);

  if (settings.loading || startOnLaunch === null && desktopError === null) return <Loading />;
  if (settings.error) return <Callout variant="danger">Narrative 参数读取失败: {settings.error}</Callout>;
  if (desktopError) return <Callout variant="danger">Narrative 启动参数读取失败: {desktopError}</Callout>;
  if (startOnLaunch === null) throw new Error('Narrative 启动参数没有返回');

  return (
    <SettingsSection icon="i-lucide:book-open" title="Narrative" description="剧情检索行为">
      <SettingsCard>
        <SwitchSetting
          title="启动 Narrative"
          hint="下次启动 Ema 时是否创建 Narrative Bridge. 本次运行不连接或断开进程."
          apply="restart"
          value={startOnLaunch}
          onSave={async value => {
            await tauriBridge.setStartNarrativeOnLaunch(value);
            setStartOnLaunch(value);
          }}
        />
        <SelectSetting
          title="剧情检索模式"
          hint="auto 由模型选择, 其余选项强制每次剧情检索使用固定模式."
          apply={settings.apply(QUERY_MODE)}
          value={requiredString(settings.values, QUERY_MODE)}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'local', label: '局部' },
            { value: 'global', label: '全局' },
            { value: 'hybrid', label: '混合' },
            { value: 'naive', label: '直接检索' },
            { value: 'mix', label: 'Mix' },
          ]}
          onSave={value => settings.save(QUERY_MODE, value)}
          onReset={() => settings.reset(QUERY_MODE)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function Loading(): JSX.Element {
  return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
}

function requiredString(values: ReadonlyMap<string, unknown>, key: string): string {
  const value = values.get(key);
  if (typeof value !== 'string') throw new Error(`参数 ${key} 没有返回字符串值`);
  return value;
}
