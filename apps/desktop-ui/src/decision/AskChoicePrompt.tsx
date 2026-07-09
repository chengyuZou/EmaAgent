import { useState, type CSSProperties } from 'react';
import { Button, Card, CardButton, Checkbox, Input } from '@ema-agent/ui';
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';

export interface AskChoicePromptProps {
  promptId:          string;
  question:          string;
  humanDescription?: string;
  options:           Array<{ label: string; description?: string }>;
  multiSelect:       boolean;
  allowCustom?:      boolean;
  onResolve(answers: string[], customText?: string): void;
  onCancel(): void;
}

export function AskChoicePrompt({
  question, humanDescription, options, multiSelect, allowCustom, onResolve, onCancel,
}: AskChoicePromptProps): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customText, setCustomText] = useState('');

  function toggle(label: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (multiSelect) {
        next.has(label) ? next.delete(label) : next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      return next;
    });
  }

  return (
    <Card variant="elevated" padding="lg" className="shadow-[var(--ema-shadow-3)] max-w-lg w-full">
      <HumanDescriptionPanel description={humanDescription ?? question} toolName="" pending={false} />
      {humanDescription && (
        <p className="mt-1 mb-3 text-sm" style={{ color: 'var(--ema-text-secondary)' }}>{question}</p>
      )}

      <div className="flex flex-col gap-2 mt-3">
        {options.map((opt, i) =>
          multiSelect ? (
            <label
              key={opt.label}
              className="flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer border transition-colors ema-stagger-in"
              style={{
                '--stagger-i':  i,
                background:     selected.has(opt.label) ? 'var(--ema-primary-muted)' : 'var(--ema-surface-1)',
                borderColor:    selected.has(opt.label) ? 'var(--ema-border-focus)' : 'var(--ema-border)',
              } as CSSProperties}
            >
              <Checkbox
                checked={selected.has(opt.label)}
                onCheckedChange={() => toggle(opt.label)}
                className="mt-0.5 shrink-0"
              />
              <div>
                <div className="text-sm" style={{ color: 'var(--ema-text-primary)' }}>{opt.label}</div>
                {opt.description && (
                  <div className="text-xs mt-0.5" style={{ color: 'var(--ema-text-tertiary)' }}>{opt.description}</div>
                )}
              </div>
            </label>
          ) : (
            <CardButton
              key={opt.label}
              selected={selected.has(opt.label)}
              padding="sm"
              className={`ema-stagger-in rounded-lg ${selected.has(opt.label) ? 'text-[var(--ema-primary-text)]' : 'text-[var(--ema-text-primary)]'}`}
              style={{ '--stagger-i': i } as CSSProperties}
              onClick={() => toggle(opt.label)}
            >
              <div className="text-sm font-medium">{opt.label}</div>
              {opt.description && (
                <div className="text-xs mt-0.5 text-[var(--ema-text-tertiary)]">{opt.description}</div>
              )}
            </CardButton>
          ),
        )}
      </div>

      {allowCustom && (
        <Input
          className="mt-3"
          placeholder="其他(自定义)…"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
        />
      )}

      <div className="flex gap-3 mt-4 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button
          variant="primary"
          size="sm"
          disabled={selected.size === 0 && !customText}
          onClick={() => onResolve([...selected], customText || undefined)}
        >
          确定
        </Button>
      </div>
    </Card>
  );
}
