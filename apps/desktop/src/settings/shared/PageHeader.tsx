// 设置页统一页头: 负字距标题 + 一行描述 + 右侧主操作槽.
// 每页一个, 由页签自己渲染(操作按钮需要页内状态, 不上提到面板).
import type { JSX, ReactNode } from 'react';

export function PageHeader({ title, description, action }: {
  title: string;
  description: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <header className="mb-0 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold tracking-[-0.03em] text-[var(--ema-text-primary)]">
          {title}
        </h1>
        <p className="mt-1 text-[13px] text-[var(--ema-text-tertiary)]">{description}</p>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 pb-0.5">{action}</div>}
    </header>
  );
}
