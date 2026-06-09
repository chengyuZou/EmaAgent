import { Button, Card } from '@ema-agent/ui';
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';

export interface AskConfirmPromptProps {
  promptId:          string;
  question:          string;
  humanDescription?: string;
  onResolve(confirmed: boolean): void;
}

export function AskConfirmPrompt({ question, humanDescription, onResolve }: AskConfirmPromptProps): JSX.Element {
  return (
    <Card variant="elevated" padding="lg" className="shadow-2xl max-w-lg w-full">
      <HumanDescriptionPanel description={humanDescription ?? question} toolName="" pending={false} />
      <p className="text-neutral-300 mt-2 text-sm">{question}</p>
      <div className="flex gap-3 mt-4 justify-end">
        <Button variant="ghost" size="sm" onClick={() => onResolve(false)}>取消</Button>
        <Button variant="primary" size="sm" onClick={() => onResolve(true)}>确认</Button>
      </div>
    </Card>
  );
}
