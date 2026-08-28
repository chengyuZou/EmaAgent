// HumanDescriptionPanel — 展示工具自带的人类可读描述。
export interface HumanDescriptionPanelProps {
  description: string;
  toolName:    string;
}

export function HumanDescriptionPanel({ description, toolName }: HumanDescriptionPanelProps): JSX.Element {
  return (
    <div className="mb-2">
      {description && (
        <p
          className={`text-base leading-relaxed ${toolName ? 'text-[var(--ema-text-primary)]' : 'text-[var(--ema-text-secondary)]'}`}
        >
          {description}
        </p>
      )}
    </div>
  );
}

/** 决策提交状态统一显示在操作按钮附近，失败时保留原卡片供用户重试。 */
export function DecisionSubmissionFeedback({
  submitting,
  error,
}: {
  submitting: boolean;
  error?: string;
}): JSX.Element | null {
  if (!submitting && !error) return null;
  return (
    <p
      role={error ? 'alert' : 'status'}
      className={`mt-2 text-xs ${error ? 'text-[var(--ema-danger-text)]' : 'text-[var(--ema-text-tertiary)]'}`}
    >
      {error ?? '正在提交决定…'}
    </p>
  );
}
