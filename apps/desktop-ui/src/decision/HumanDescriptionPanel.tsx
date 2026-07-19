/** HumanDescriptionPanel — display the human-readable description, or loading placeholder. */
export interface HumanDescriptionPanelProps {
  description: string;
  toolName:    string;
  pending:     boolean;
}

export function HumanDescriptionPanel({ description, toolName, pending }: HumanDescriptionPanelProps): JSX.Element {
  if (pending) {
    return (
      <div className="mb-3">
        <div className="h-6 w-3/4 rounded-lg ema-skeleton-pulse" />
      </div>
    );
  }

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
