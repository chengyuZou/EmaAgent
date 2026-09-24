import { useEffect, useState, type JSX } from 'react';
import { Button, Callout, Spinner } from '@ema-agent/ui';
import { narrativeApi } from '../../../api/narrative.js';
import { tauriBridge } from '../../../lib/tauri-bridge.js';
import { SettingItem, SettingsCard, SettingsSection } from '../../shared/SettingItem.js';
import { SelectSetting } from '../controls/SelectSetting.js';
import { SwitchSetting } from '../controls/SwitchSetting.js';
import { useSettingValues } from '../useSettingValues.js';

const QUERY_MODE = 'narrative.queryMode';
const START_ON_LAUNCH = 'narrative.startOnLaunch';

export function NarrativeParameters(): JSX.Element {
  const settings = useSettingValues();
  const [port, setPort] = useState<number | null>(null);
  const [portLoading, setPortLoading] = useState(true);
  const [operation, setOperation] = useState<'starting' | 'stopping' | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  useEffect(() => {
    if (operation !== null) return;
    let mounted = true;
    const refresh = (): void => {
      void tauriBridge.getNarrativePort()
        .then(value => { if (mounted) setPort(value); })
        .catch(cause => {
          if (mounted) setOperationError(cause instanceof Error ? cause.message : 'Narrative 端口读取失败');
        })
        .finally(() => { if (mounted) setPortLoading(false); });
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [operation]);

  async function start(): Promise<void> {
    if (operation !== null) return;
    setOperation('starting');
    setOperationError(null);
    try {
      setPort(await tauriBridge.startNarrative());
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : 'Narrative 启动失败');
      setPort(await tauriBridge.getNarrativePort().catch(() => null));
    } finally {
      setOperation(null);
    }
  }

  async function stop(): Promise<void> {
    if (operation !== null) return;
    setOperation('stopping');
    setOperationError(null);
    try {
      await narrativeApi.shutdown();
      await tauriBridge.waitNarrativeExit();
      setPort(null);
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : 'Narrative 关闭失败');
      setPort(await tauriBridge.getNarrativePort().catch(() => null));
    } finally {
      setOperation(null);
    }
  }

  if (settings.loading || portLoading) return <Loading />;
  if (settings.error) return <Callout variant="danger">Narrative 参数读取失败: {settings.error}</Callout>;

  return (
    <SettingsSection icon="i-lucide:book-open" title="Narrative" description="剧情检索行为">
      {operationError && <Callout variant="danger">{operationError}</Callout>}
      <SettingsCard>
        <SwitchSetting
          title="下次启动时自动启动 Narrative"
          hint="只影响下次打开 Ema, 不改变本次运行状态."
          apply={settings.apply(START_ON_LAUNCH)}
          value={requiredBoolean(settings.values, START_ON_LAUNCH)}
          onSave={value => settings.save(START_ON_LAUNCH, value)}
          onReset={() => settings.reset(START_ON_LAUNCH)}
        />
        <SettingItem
          title="当前 Narrative Bridge"
          hint={port === null ? '未接入或正在启动' : `正在运行, 端口 ${port}`}
        >
          <Button
            size="sm"
            disabled={operation !== null || !tauriBridge.isTauri()}
            onClick={() => void (port === null ? start() : stop())}
          >
            {operation === 'starting' ? '启动中' : operation === 'stopping' ? '关闭中' : port === null ? '立即启动' : '关闭'}
          </Button>
        </SettingItem>
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

function requiredBoolean(values: ReadonlyMap<string, unknown>, key: string): boolean {
  const value = values.get(key);
  if (typeof value !== 'boolean') throw new Error(`参数 ${key} 没有返回布尔值`);
  return value;
}

function Loading(): JSX.Element {
  return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
}

function requiredString(values: ReadonlyMap<string, unknown>, key: string): string {
  const value = values.get(key);
  if (typeof value !== 'string') throw new Error(`参数 ${key} 没有返回字符串值`);
  return value;
}
