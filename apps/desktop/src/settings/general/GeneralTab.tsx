// 提供事件通知和系统环境状态等需要专属交互的桌面设置。
import type { JSX } from 'react';
import { EventDisplaySettings } from './EventDisplaySettings.js';
import { SandboxStatusSettings } from './SandboxStatusSettings.js';

export function GeneralTab(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 pb-8">
      <header>
        <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">通知与环境</h1>
        <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">
          管理桌面事件提示的展示方式，并查看当前工具执行环境。
        </p>
      </header>

      <SandboxStatusSettings />

      <div className="h-px bg-[var(--ema-border)]" />
      <EventDisplaySettings />
    </div>
  );
}
