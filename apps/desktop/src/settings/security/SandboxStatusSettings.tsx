import { useEffect, useId, useState, type JSX } from 'react';
import { Button, Callout, Select, Spinner } from '@ema-agent/ui';
import { settingsApi } from '../../api/settings.js';
import { systemApi, type SandboxStatus } from '../../api/system.js';
import { showToast } from '../../lib/notifications/toast.js';
import { SettingsSection } from '../shared/SettingItem.js';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: SandboxStatus };

type SaveState = 'idle' | 'saving' | 'failed';

const BACKEND_LABEL: Record<SandboxStatus['backend'], string> = {
  bubblewrap: 'bubblewrap(Linux 系统沙箱)',
  'sandbox-exec': 'sandbox-exec(macOS 系统沙箱)',
  unisolated: '无操作系统沙箱',
};

const EXECUTION_LABEL: Record<SandboxStatus['bashMode'], string> = {
  sandboxed: '使用操作系统沙箱',
  disabled: '已禁用',
  unsandboxed: '已启用, 无操作系统沙箱',
};

const NETWORK_OPTIONS = [
  { value: 'none', label: '无网络' },
  { value: 'full', label: '完全网络' },
];

export function SandboxStatusSettings(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const load = (): void => {
    void systemApi.getSandboxStatus()
      .then(status => setState({ kind: 'ready', status }))
      .catch((error: unknown) => setState({
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
        load();
      })
      .catch((error: unknown) => {
        setSaveState('failed');
        showToast(error instanceof Error ? error.message : '沙箱网络设置保存失败', { variant: 'danger' });
      });
  };

  const status = state.kind === 'ready' ? state.status : null;
  let executionTone: 'ok' | 'bad' | undefined;
  if (status?.bashMode === 'sandboxed') {
    executionTone = 'ok';
  } else if (status?.bashMode === 'unsandboxed') {
    executionTone = 'bad';
  }

  return (
    <SettingsSection
      icon="i-lucide:terminal"
      title="命令执行"
      description="Bash 的沙箱后端与网络设置"
    >
      {state.kind === 'loading' && (
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      )}
      {state.kind === 'error' && (
        <div className="flex flex-col gap-3">
          <Callout variant="danger">{state.message}</Callout>
          <Button variant="secondary" size="sm" className="self-start" onClick={load}>
            重新加载
          </Button>
        </div>
      )}
      {state.kind === 'ready' && status && (
        <>
          <div className="ema-glass-weak grid grid-cols-1 gap-x-6 gap-y-3 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-4">
            <StatusRow label="Bash 沙箱后端" value={BACKEND_LABEL[status.backend]} />
            <StatusRow
              label="Bash 执行"
              value={EXECUTION_LABEL[status.bashMode]}
              tone={executionTone}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--ema-text-tertiary)]">Bash 沙箱网络</span>
              <Select
                className="w-40"
                value={status.networkAccess}
                disabled={saveState === 'saving' || status.bashMode !== 'sandboxed'}
                options={NETWORK_OPTIONS}
                onChange={saveNetwork}
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-[var(--ema-text-tertiary)]">
            网络设置只对操作系统沙箱中的 Bash 生效. 修改后从下一次 Turn 开始使用.
            原生 PowerShell 不经过此沙箱, 仍按命令进行权限检查.
          </p>
          {status.warning && (
            <SandboxWarning message={status.warning} details={status.warningDetails} />
          )}
          {status.bashMode === 'unsandboxed' && (
            <Callout variant="danger" className="mt-3">
              开发开关允许 Bash 在没有操作系统沙箱的情况下运行, 文件和网络限制不会由沙箱实施.
            </Callout>
          )}
          {status.bashMode === 'disabled' && (
            <Callout variant="warn" className="mt-3">
              当前没有可用的操作系统沙箱, Bash 工具已禁用. 这不影响原生 PowerShell 的独立权限流程.
            </Callout>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function SandboxWarning({ message, details }: { message: string; details?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const detailsId = useId();

  return (
    <Callout variant="warn" className="mt-3">
      <p>{message}</p>
      {details && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-auto px-0 py-1 text-xs"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen(current => !current)}
          >
            <span>{open ? '收起详情' : '查看详情'}</span>
            <span
              className={`i-lucide:chevron-down transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </Button>
          <div
            id={detailsId}
            className="ema-collapsible motion-reduce:transition-none"
            style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
            aria-hidden={!open}
          >
            <div className="min-h-0 overflow-hidden">
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--ema-surface-2)] p-3 font-mono text-xs text-[var(--ema-text-secondary)]">
                {details}
              </pre>
            </div>
          </div>
        </>
      )}
    </Callout>
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
}): JSX.Element {
  let color = 'text-[var(--ema-text-primary)]';
  if (tone === 'ok') {
    color = 'text-[var(--ema-success)]';
  } else if (tone === 'bad') {
    color = 'text-[var(--ema-danger)]';
  }

  return (
    <div className="flex min-h-10 items-center justify-between gap-6">
      <span className="shrink-0 text-sm text-[var(--ema-text-tertiary)]">
        {label}
      </span>
      <span className={`text-right text-sm font-medium ${color}`}>
        {value}
      </span>
    </div>
  );
}
