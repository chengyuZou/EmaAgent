/** ThinkingBlock — collapsible thinking/reasoning display. */
import { useState } from 'react';

export interface ThinkingBlockProps {
  text: string;
}

export function ThinkingBlock({ text }: ThinkingBlockProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="my-1">
      <button
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span>{open ? '▼' : '▶'}</span>
        <span>💭 思考中</span>
      </button>
      {open && (
        <div className="mt-1.5 pl-5 border-l-2 border-gray-600 text-sm text-gray-400 italic whitespace-pre-wrap leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}
