// 安全与隔离:展示当前机器真实启用的沙箱等级,沙箱网络档位可直接在此切换。
// 保护性禁用(裸 Windows 默认)不是故障,不用危险色;红只留给不安全覆盖。
import { useEffect, useState, type JSX } from 'react';
import { Button, Callout, Select, Spinner } from '@ema-agent/ui';
import { settingsApi } from '../../api/settings.js';
import { systemApi, type SandboxStatus } from '../../api/system.js';
import { showToast } from '../../lib/toast.js';
import { SettingsSection } from '../shared/SettingItem.js';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: SandboxStatus; network: SandboxNetwork };

type SandboxNetwork = SandboxStatus['sandboxNetwork'];
type SaveState = 'idle' | 'saving' | 'failed';

const BACKEND_LABEL: Record<SandboxStatus['kind'], string> = {
  'bubblewrap':  'bubblewrap(Linux 系统沙箱)',
  'sandbox-exec': 'sandbox-exec(macOS 系统沙箱)',
  'unisolated':  '应用层(无操作系统沙箱)',
};

/** 命令执行行的人话映射:disabled 只摘了 Bash 工具,PowerShell 逐条授权照常。 */
const EXECUTION_LABEL: Record<SandboxStatus['shellExecution'], string> = {
  'isolated':        '已隔离',
  'disabled':        'Bash 保护性关闭 · PowerShell 逐条授权可用',
  'unsafe-override': '不安全覆盖',
};

const NETWORK_OPTIONS = [
  { value: 'none', label: '无网络' },
  { value: 'full', label: '完全网络' },
];

export function SandboxStatusSettings(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const load = (): void => {
    void Promise.all([
      systemApi.getSandboxStatus(),
      settingsApi.getValue('sandbox.network'),
    ]).then(([status, setting]) => {
      const network: SandboxNetwork = setting.value === 'full' ? 'full' : 'none';
      setState({ kind: 'ready', status, network });
    }).catch((error: unknown) => setState({
      kind: 'error',
      message: error instanceof Error ? error.message : '读取沙箱状态失败',
    }));
  };

  useEffect(load, []);

  const saveNetwork = (value: string): void => {
    if (value !== 'none' && value !== 'full') return;
    setSaveState('saving');
    settingsApi.putValue('sandbox.network', value)
      .then(() => {
        setSaveState('idle');
        // 服务端警告文案随档位变化,重拉状态保持同步。
        load();
      })
      .catch((error: unknown) => {
        setSaveState('failed');
        showToast(error instanceof Error ? error.message : '沙箱网络设置保存失败', { variant: 'danger' });
      });
  };

  const status = state.kind === 'ready' ? state.status : null;
  const unsafe = status?.shellExecution === 'unsafe-override';
  const appOnly = status !== null && status.isolation === 'application-only';

  return (
    <SettingsSection
      icon={unsafe
        ? 'i-lucide:shield-off'
        : appOnly
          ? 'i-lucide:shield-alert'
          : 'i-lucide:shield-check'}
      iconClassName={unsafe
        ? 'text-[var(--ema-danger)]'
        : appOnly
          ? 'text-[var(--ema-warning)]'
          : 'text-[var(--ema-success)]'}
      title="安全与隔离"
      description="AI 在本机执行命令与访问网络时的真实隔离等级"
    >
      {state.kind === 'loading' && (
        <div className="flex justify-center py-4"><Spinner size="sm" /></div>
      )}
      {state.kind === 'error' && (
        <div className="flex flex-col gap-3">
          <Callout variant="danger">{state.message}</Callout>
          <Button variant="secondary" size="sm" className="self-start" onClick={load}>重新加载</Button>
        </div>
      )}

      {state.kind === 'ready' && status && (
        <>
          <div className="ema-glass-weak grid grid-cols-1 gap-x-6 gap-y-3 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-4 ">
            <StatusRow label="隔离后端" value={BACKEND_LABEL[status.kind] ?? status.kind} />
            <StatusRow
              label="命令执行"
              value={EXECUTION_LABEL[status.shellExecution] ?? status.shellExecution}
              tone={status.shellExecution === 'isolated'
                ? 'ok'
                : status.shellExecution === 'unsafe-override'
                  ? 'bad'
                  : undefined}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--ema-text-tertiary)]">沙箱网络</span>
              <Select
                className="w-40"
                value={state.network}
                disabled={saveState === 'saving'}
                options={NETWORK_OPTIONS}
                onChange={saveNetwork}
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-[var(--ema-text-tertiary)]">
            沙箱网络是全有或全无;按域名放行要等沙箱网络策略上线。
          </p>
          {status.warning && (
            <Callout variant="warn" className="mt-3">{status.warning}</Callout>
          )}
          {unsafe && (
            <Callout variant="danger" className="mt-3">
              沙箱已被手动关闭(不安全覆盖),AI 执行的命令将直接运行在你的系统中,请确认你了解风险。
            </Callout>
          )}
          {!unsafe && appOnly && (
            <Callout variant="warn" className="mt-3">
              当前系统不支持系统级沙箱,AI 执行的命令仅在应用层隔离下运行,请留意每一次权限确认。
            </Callout>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'bad';
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-6">
      <span className="shrink-0 text-sm text-[var(--ema-text-tertiary)]">
        {label}
      </span>
      <span
        className={`text-right text-sm font-medium ${
          tone === 'ok'
            ? 'text-[var(--ema-success)]'
            : tone === 'bad'
              ? 'text-[var(--ema-danger)]'
              : 'text-[var(--ema-text-primary)]'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
