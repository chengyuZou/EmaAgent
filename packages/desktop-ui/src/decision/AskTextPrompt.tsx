/** AskTextPrompt — free-text input modal. */
import { useState } from 'react';
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
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-2xl">
      <HumanDescriptionPanel description={humanDescription ?? question} toolName="" pending={false} />
      <p className="text-gray-300 mt-2">{question}</p>
      <textarea
        className="w-full mt-3 bg-gray-800 border border-gray-600 rounded-xl p-3 text-sm text-gray-200 resize-none focus:outline-none focus:border-pink-400/50"
        rows={4}
        placeholder={placeholder ?? '输入…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-3 mt-4 justify-end">
        <button
          className="px-4 py-2 rounded-xl bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
          onClick={onCancel}
        >取消</button>
        <button
          className="px-4 py-2 rounded-xl bg-pink-400/20 text-pink-300 hover:bg-pink-400/30 transition-colors"
          onClick={() => onResolve(text)}
        >提交</button>
      </div>
    </div>
  );
}
