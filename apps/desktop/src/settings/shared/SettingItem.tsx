// 设置页共用骨架:SettingItem 行(标题 + 大白话副标题 + 控件)、分组卡片、节头与高级项折叠。
import { useState, type JSX, type ReactNode } from 'react';
import type { SettingApply } from '../../api/settings.js';

/** 即存反馈状态（纯 UI 状态；useObjectSetting 对象镜像已删除）。 */
type SettingSaveState = 'idle' | 'saving' | 'saved' | 'failed';

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
  title, hint, apply, children,
}: {
  title: string;
  hint: string;
  apply?: SettingApply;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 transition-colors duration-[var(--ema-duration-base)] hover:bg-[var(--ema-surface-2)]/55">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-[13px] font-medium text-[var(--ema-text-primary)]">{title}</div>
          {apply && <SettingApplyBadge apply={apply} />}
        </div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--ema-text-tertiary)]">{hint}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** 一组 SettingItem 的容器卡片,行间细分隔线。 */
export function SettingsCard({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="ema-glass-weak ema-card-decorate ema-stagger-in divide-y divide-[var(--ema-border)] overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] transition-ema hover:-translate-y-0.5 hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]">
      {children}
    </div>
  );
}

const APPLY_PRESENTATION: Readonly<Record<SettingApply, { label: string; className: string }>> = {
  immediate: {
    label: '立即生效',
    className: 'bg-[var(--ema-success-muted)] text-[var(--ema-success-text)]',
  },
  nextOperation: {
    label: '下次操作生效',
    className: 'bg-[var(--ema-info-muted)] text-[var(--ema-info-text)]',
  },
  nextTurn: {
    label: '下一轮对话生效',
    className: 'bg-[var(--ema-violet-muted)] text-[var(--ema-violet-text)]',
  },
  restart: {
    label: '重启后生效',
    className: 'bg-[var(--ema-warning-muted)] text-[var(--ema-warning-text)]',
  },
};

export function SettingApplyBadge({ apply }: { apply: SettingApply }): JSX.Element {
  const presentation = APPLY_PRESENTATION[apply];
  return (
    <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${presentation.className}`}>
      {presentation.label}
    </span>
  );
}

/** Provider 同款节头:大图标 + 描述 + 大标题,右侧可放生效时机标注。 */
export function SettingsSection({
  icon, title, description, trailing, children,
}: {
  icon: string;
  title: string;
  description: string;
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
      </div>
      {children}
    </section>
  );
}

/** 高级项折叠:默认收起,展开有动画 */
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
