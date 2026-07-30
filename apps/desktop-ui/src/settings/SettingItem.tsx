// 设置页共用骨架:SettingItem 行(标题 + 大白话副标题 + 控件)、分组卡片、节头与高级项折叠。
import { useState, type JSX, type ReactNode } from 'react';
import type { SettingSaveState } from './useObjectSetting.js';

/** 即存反馈:保存中转圈、成功 ✓ 淡入、失败红点;idle 不占位。 */
export function SaveStateIndicator({ state }: { state: SettingSaveState }): JSX.Element | null {
  if (state === 'idle') return null;
  if (state === 'saving') {
    return <span className="i-svg-spinners:ring-resize text-xs text-[var(--ema-text-tertiary)]" aria-label="保存中" />;
  }
  if (state === 'saved') {
    return <span className="i-lucide:check text-sm ema-fade-in text-[var(--ema-success)]" aria-label="已保存" />;
  }
  return <span className="i-lucide:circle-alert text-sm text-[var(--ema-danger)]" aria-label="保存失败" />;
}

/** 左标题+副标题,右控件。 */
export function SettingItem({
  title, hint, children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[var(--ema-text-primary)]">{title}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--ema-text-tertiary)]">{hint}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** 一组 SettingItem 的容器卡片,行间细分隔线。 */
export function SettingsCard({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="ema-glass-weak divide-y divide-[var(--ema-border)] rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      {children}
    </div>
  );
}

/** Provider 同款节头:大图标 + 描述 + 大标题,右侧可放生效时机标注。 */
export function SettingsSection({
  icon, title, description, applyNote, trailing, children,
}: {
  icon: string;
  title: string;
  description: string;
  /** 生效时机说明,如"下一轮对话生效";apply=nextOperation 的节不传。 */
  applyNote?: string;
  /** 节头右侧追加内容(如 SaveStateIndicator)。 */
  trailing?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section>
      <div className="mb-3 flex items-center gap-3 ema-stagger-in">
        <span className={`${icon} text-3xl text-[var(--ema-text-tertiary)]`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-[var(--ema-text-tertiary)]">{description}</p>
          <h2 className="text-xl font-semibold text-[var(--ema-text-primary)]">{title}</h2>
        </div>
        {trailing}
        {applyNote && (
          <span className="shrink-0 rounded-md px-2 py-0.5 text-[11px] bg-[var(--ema-info-muted)] text-[var(--ema-info-text)]">
            {applyNote}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/** 高级项折叠:默认收起,展开有动画;专家参数不吓退普通用户。 */
export function AdvancedSettings({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        className="flex w-full items-center gap-1.5 px-4 py-2.5 text-[11px] transition-colors text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]"
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className="i-lucide:chevron-down text-xs transition-transform duration-[var(--ema-duration-base)]"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden
        />
        高级设置
      </button>
      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="divide-y divide-[var(--ema-border)] border-t border-[var(--ema-border)]">
          {children}
        </div>
      </div>
    </div>
  );
}
