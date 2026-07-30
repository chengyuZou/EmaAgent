// 安全与隔离只读状态:展示当前机器真实启用的沙箱等级,裸 Windows 如实降级提示,不伪装安全。
import { useEffect, useState, type JSX } from 'react';
import { Button, Callout, Spinner } from '@ema-agent/ui';
import { systemApi, type SandboxStatusWire } from '../api/system.js';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: SandboxStatusWire };

const BACKEND_LABEL: Record<SandboxStatusWire['backend'], string> = {
  'bubblewrap':  'bubblewrap(Linux 系统沙箱)',
  'sandbox-exec': 'sandbox-exec(macOS 系统沙箱)',
  'app-layer':   '应用层(无操作系统沙箱)',
};

const EXECUTION_LABEL: Record<'isolated' | 'disabled' | 'unsafe-override', string> = {
  'isolated':        '已隔离',
  'disabled':        '已禁用',
  'unsafe-override': '不安全覆盖',
};

export function SandboxStatusSettings(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = (): void => {
    setState({ kind: 'loading' });
    systemApi.getSandboxStatus()
      .then((status) => setState({ kind: 'ready', status }))
      .catch((error: unknown) => setState({
        kind: 'error',
        message: error instanceof Error ? error.message : '读取沙箱状态失败',
      }));
  };

  useEffect(load, []);

  const status = state.kind === 'ready' ? state.status : null;
  const unsafe = status !== null
    && (status.shellExecution === 'unsafe-override' || status.localMcpStdio === 'unsafe-override');
  const appOnly = status !== null && status.isolation === 'application-only';

  return (
    <section>
      {/* Provider 同款节头:大图标 + 描述 + 标题。 */}
      <div className="mb-4 flex items-center gap-3 ema-stagger-in">
        <span
          className={`text-4xl ${unsafe
            ? 'i-lucide:shield-off text-[var(--ema-danger)]'
            : appOnly
              ? 'i-lucide:shield-alert text-[var(--ema-warning)]'
              : 'i-lucide:shield-check text-[var(--ema-success)]'}`}
          aria-hidden
        />
        <div>
          <p className="text-sm text-[var(--ema-text-tertiary)]">
            AI 在本机执行命令与访问网络时的真实隔离等级
          </p>
          <h2 className="text-2xl font-semibold text-[var(--ema-text-primary)]">安全与隔离</h2>
        </div>
      </div>

      {state.kind === 'loading' && (
        <div className="flex justify-center py-4"><Spinner size="sm" /></div>
      )}
      {state.kind === 'error' && (
        <div className="flex flex-col gap-3">
          <Callout variant="danger">{state.message}</Callout>
          <Button variant="secondary" size="sm" className="self-start" onClick={load}>重新加载</Button>
        </div>
      )}

      {status && (
        <>
          <div className="ema-glass-weak grid grid-cols-1 gap-x-6 gap-y-3 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-4 sm:grid-cols-2">
            <StatusRow label="隔离后端" value={BACKEND_LABEL[status.backend]} />
            <StatusRow
              label="命令执行"
              value={EXECUTION_LABEL[status.shellExecution]}
              tone={status.shellExecution === 'isolated' ? 'ok' : 'bad'}
            />
            <StatusRow
              label="沙箱网络"
              value={status.sandboxNetwork === 'none' ? '无网络' : '完全网络'}
            />
            <StatusRow
              label="本地 MCP"
              value={EXECUTION_LABEL[status.localMcpStdio]}
              tone={status.localMcpStdio === 'isolated' ? 'ok' : 'bad'}
            />
          </div>
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
    </section>
  );
}

function StatusRow({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'bad';
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 shrink-0 text-[var(--ema-text-tertiary)]">{label}</span>
      {tone && (
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: tone === 'ok' ? 'var(--ema-success)' : 'var(--ema-danger)' }}
          aria-hidden
        />
      )}
      <span className="text-[var(--ema-text-secondary)]">{value}</span>
    </div>
  );
}
