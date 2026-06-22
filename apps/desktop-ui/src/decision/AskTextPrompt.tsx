import { useState } from 'react';
import { Button, Card, Textarea } from '@ema-agent/ui';
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';

export interface AskTextPromptProps {
  promptId:          string;
  question:          string;
  humanDescription?: string;
  placeholder?:      string;
  onResolve(text: string): void;
  onCancel(): void;
}

export function AskTextPrompt({ question, humanDescription, placeholder, onResolve, onCancel }: AskTextPromptProps): JSX.Element {
  const [text, setText] = useState('');

  return (
    <Card variant="elevated" padding="lg" className="shadow-2xl max-w-lg w-full">
      <HumanDescriptionPanel description={humanDescription ?? question} toolName="" pending={false} />
      {humanDescription && (
        <p className="mt-1 mb-3 text-sm" style={{ color: 'var(--ema-text-secondary)' }}>{question}</p>
      )}
      <Textarea
        className="mt-2"
        minRows={4}
        maxRows={8}
        placeholder={placeholder ?? '输入…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <div className="flex gap-3 mt-4 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button variant="primary" size="sm" disabled={!text.trim()} onClick={() => onResolve(text.trim())}>
          提交
        </Button>
      </div>
    </Card>
  );
}
