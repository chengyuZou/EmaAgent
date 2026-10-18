import type { JSX } from 'react';
import { PageHeader } from '../shared/PageHeader.js';
import { SandboxStatusSettings } from './SandboxStatusSettings.js';
import { TerminalShellSettings } from './TerminalShellSettings.js';

export function SecurityTab(): JSX.Element {
  return (
    <div className="mx-auto flex w-[100%] flex-col gap-8 pb-8">
      <PageHeader title="安全" description="执行环境的真实隔离等级，沙箱网络与集成终端" />

      <SandboxStatusSettings />

      <div className="h-px bg-[var(--ema-border)]" />
      <TerminalShellSettings />
    </div>
  );
}
