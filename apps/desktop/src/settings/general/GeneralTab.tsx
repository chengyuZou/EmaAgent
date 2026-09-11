// 提供系统环境状态等需要专属交互的桌面设置;事件通知已迁入参数设置。
import type { JSX } from 'react';
import { SandboxStatusSettings } from './SandboxStatusSettings.js';
import { TerminalShellSettings } from './TerminalShellSettings.js';

export function GeneralTab(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 pb-8">
      <header>
        <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">环境</h1>
        <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">
          查看当前工具执行环境与终端配置。
        </p>
      </header>

      <SandboxStatusSettings />

      <div className="h-px bg-[var(--ema-border)]" />
      <TerminalShellSettings />
    </div>
  );
}
