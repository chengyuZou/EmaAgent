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
        <div className="h-6 w-3/4 rounded-lg bg-gray-700 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="mb-2">
      {description && (
        <p className={`text-base ${!toolName ? 'text-gray-300' : 'text-gray-200'} leading-relaxed`}>
          {description}
        </p>
      )}
    </div>
  );
}
