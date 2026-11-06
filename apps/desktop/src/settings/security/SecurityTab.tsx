import type { JSX } from 'react';
import { PageHeader } from '../shared/PageHeader.js';
import { SandboxStatusSettings } from './SandboxStatusSettings.js';
import { TerminalShellSettings } from './TerminalShellSettings.js';
import { CommandEnvironmentSettings } from './CommandEnvironmentSettings.js';

export function SecurityTab(): JSX.Element {
  return (
    <div className="mx-auto flex w-[100%] flex-col gap-8 pb-8">
      <PageHeader title="安全" description="执行环境的真实隔离等级, 沙箱网络, 命令环境与集成终端" />

      <SandboxStatusSettings />

      <div className="h-px bg-[var(--ema-border)]" />
      <CommandEnvironmentSettings />

      <div className="h-px bg-[var(--ema-border)]" />
      <TerminalShellSettings />
    </div>
  );
}
