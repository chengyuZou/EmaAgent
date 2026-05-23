/** AskConfirmPrompt — binary confirm/cancel. */
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';

export interface AskConfirmPromptProps {
  promptId:          string;
  question:          string;
  humanDescription?: string;
  onResolve(confirmed: boolean): void;
}

export function AskConfirmPrompt({ question, humanDescription, onResolve }: AskConfirmPromptProps): JSX.Element {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-2xl">
      <HumanDescriptionPanel description={humanDescription ?? question} toolName="" pending={false} />
      <p className="text-gray-300 mt-2">{question}</p>
      <div className="flex gap-3 mt-4 justify-end">
        <button
          className="px-4 py-2 rounded-xl bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
          onClick={() => onResolve(false)}
        >取消</button>
        <button
          className="px-4 py-2 rounded-xl bg-pink-400/20 text-pink-300 hover:bg-pink-400/30 transition-colors"
          onClick={() => onResolve(true)}
        >确认</button>
      </div>
    </div>
  );
}
