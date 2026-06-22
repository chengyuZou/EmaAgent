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
        <div className="h-6 w-3/4 rounded-lg animate-pulse" style={{ background: 'var(--ema-surface-2)' }} />
      </div>
    );
  }

  return (
    <div className="mb-2">
      {description && (
        <p
          className="text-base leading-relaxed"
          style={{ color: toolName ? 'var(--ema-text-primary)' : 'var(--ema-text-secondary)' }}
        >
          {description}
        </p>
      )}
    </div>
  );
}
