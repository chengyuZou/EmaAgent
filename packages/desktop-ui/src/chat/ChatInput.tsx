/**
 * ChatInput — bottom input area with Textarea + circular send button + toolbar.
 *
 * The send button is an "embeddedAction" inside the Textarea (bottom-right).
 * Toolbar sits below: TTS toggle + Mode selector.
 */
import { useState, useCallback, type KeyboardEvent, type JSX } from 'react';
import { useChatStore } from '../stores/chat-store.js';
import { useUiStore } from '../stores/ui-store.js';
import { ModeSelector } from './ModeSelector.js';
import type { TurnMode, AgentSubMode } from '@ema-agent/contracts';

export function ChatInput(): JSX.Element {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<TurnMode>('chat');
  const [subMode, setSubMode] = useState<AgentSubMode | undefined>();
  const streaming = useChatStore((s) => s.streamingMessage);
  const ttsEnabled = useUiStore((s) => s.ttsEnabled);
  const [isComposing, setIsComposing] = useState(false);

  const canSend = text.trim().length > 0 && !streaming;

  const send = useCallback(() => {
    if (!canSend) return;
    void useChatStore.getState().sendMessage({
      mode,
      subMode,
      text: text.trim(),
      ttsEnabled,
    });
    setText('');
  }, [canSend, mode, subMode, text, ttsEnabled]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex-shrink-0 border-t border-gray-800 px-4 py-3">
      <div className="max-w-2xl mx-auto">
        {/* Textarea wrapper with embedded send button */}
        <div className="relative">
          <textarea
            className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 pr-12 text-sm text-gray-200 resize-none focus:outline-none focus:border-pink-400/50 placeholder-gray-500"
            rows={3}
            placeholder="输入消息…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
          />

          {/* Embedded circular send button */}
          <button
            className={`absolute right-2 bottom-2 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
              canSend
                ? 'bg-pink-400/20 text-pink-300 hover:bg-pink-400/30'
                : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
            disabled={!canSend}
            onClick={send}
            aria-label="发送"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 8l14-7-7 14-2-7z" />
            </svg>
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1">
            {/* TTS toggle */}
            <button
              className={`px-2 py-1 rounded-lg text-xs transition-colors ${
                ttsEnabled
                  ? 'bg-pink-400/20 text-pink-300'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
              onClick={() => useUiStore.getState().setTtsEnabled(!ttsEnabled)}
              aria-label="切换 TTS"
            >
              🔊
            </button>

            {/* Mode selector */}
            <ModeSelector mode={mode} subMode={subMode} onModeChange={(m, sm) => { setMode(m); setSubMode(sm); }} />
          </div>

          {/* Streaming indicator */}
          {streaming && (
            <div className="text-xs text-gray-500 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-pink-400 animate-pulse" />
              生成中…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
