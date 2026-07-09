import { Button, Card } from '@ema-agent/ui';
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';

export interface AskConfirmPromptProps {
  promptId:          string;
  question:          string;
  humanDescription?: string;
  onResolve(confirmed: boolean): void;
  onCancel(): void;
}

export function AskConfirmPrompt({ question, humanDescription, onResolve, onCancel }: AskConfirmPromptProps): JSX.Element {
  return (
    <Card variant="elevated" padding="lg" className="shadow-[var(--ema-shadow-3)] max-w-lg w-full">
      <HumanDescriptionPanel description={humanDescription ?? question} toolName="" pending={false} />
      {humanDescription && (
        <p className="mt-2 text-sm text-[var(--ema-text-secondary)]">{question}</p>
      )}
      <div className="flex gap-3 mt-5 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button variant="danger" size="sm" onClick={() => onResolve(false)}>否</Button>
        <Button variant="primary" size="sm" onClick={() => onResolve(true)}>确认</Button>
      </div>
    </Card>
  );
}
