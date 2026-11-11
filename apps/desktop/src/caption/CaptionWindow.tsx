import { useEffect, useState, type JSX } from 'react';
import { IconButton, Tooltip } from '@ema-agent/ui';
import { mountSystemEvents } from '../lib/events/systemSse.js';
import { tauriBridge } from '../lib/tauri/tauriBridge.js';
import { useThemeSync } from '../stores/theme.js';
import { SpeechCaption } from './SpeechCaption.js';

export function CaptionWindow(): JSX.Element {
  const [windowFailureMessage, setWindowFailureMessage] = useState<string | null>(null);
  useThemeSync();
  // Stage 已持有系统 SSE, 此窗口只接收其广播, 让字幕的外观设置随修改更新.
  useEffect(() => mountSystemEvents({ ownsConnection: false }), []);

  const runWindowAction = (action: () => Promise<void>): void => {
    setWindowFailureMessage(null);
    void action().catch(error => {
      setWindowFailureMessage(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <main className="ema-caption-window" aria-label="字幕窗口">
      {/* 控制栏不随 SpeechCaption 的淡出卸载, 无字幕时仍能拖动或关闭窗口. */}
      <header className="ema-caption-toolbar">
        <div
          className="ema-caption-drag-region"
          onMouseDown={event => {
            if (event.button === 0) runWindowAction(() => tauriBridge.startDragging());
          }}
        >
          <span className="i-lucide:grip-horizontal" aria-hidden />
          <span>字幕</span>
        </div>
        <Tooltip content="关闭字幕窗口">
          <IconButton
            label="关闭字幕窗口"
            icon="i-lucide:x"
            variant="ghost"
            size="sm"
            onClick={() => runWindowAction(() => tauriBridge.closeCaptionWindow())}
          />
        </Tooltip>
      </header>
      {windowFailureMessage && (
        <p className="ema-caption-window-error" role="alert">{windowFailureMessage}</p>
      )}
      <SpeechCaption />
    </main>
  );
}
