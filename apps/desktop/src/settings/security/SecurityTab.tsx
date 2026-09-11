// 安全页:沙箱隔离状态与集成终端配置,原"通知与环境"页更名(通知早已迁入参数设置)。
import type { JSX } from 'react';
import { SandboxStatusSettings } from './SandboxStatusSettings.js';
import { TerminalShellSettings } from './TerminalShellSettings.js';

export function SecurityTab(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 pb-8">
      <header>
        <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">安全</h1>
        <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">
          查看工具执行环境的真实隔离等级，并配置沙箱网络与集成终端。
        </p>
      </header>

      <SandboxStatusSettings />

      <div className="h-px bg-[var(--ema-border)]" />
      <TerminalShellSettings />
    </div>
  );
}
