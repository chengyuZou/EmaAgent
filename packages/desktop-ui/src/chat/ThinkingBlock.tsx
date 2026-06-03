/**
 * ThinkingBlock — collapsible thinking/reasoning. Styled as AIRI callout (violet theme):
 * left accent bar + semi-transparent bg.
 */
import { useState, type JSX } from 'react';

export interface ThinkingBlockProps {
  text: string;
}

export function ThinkingBlock({ text }: ThinkingBlockProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg bg-violet-900/50 relative pl-5 pr-3 py-2 flex flex-col gap-1
                    before:content-[''] before:absolute before:left-2 before:top-2 before:bottom-2 before:w-1 before:rounded-full before:bg-violet-400/40">
      <button
        className="flex items-center gap-1.5 text-xs text-violet-300 hover:text-violet-200 transition-colors text-left w-full"
        onClick={() => setOpen(!open)}
      >
        <span>{open ? '▼' : '▶'}</span>
        <span className="font-semibold">思考过程</span>
      </button>
      {open && (
        <div className="text-sm text-violet-200/80 italic whitespace-pre-wrap leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}
