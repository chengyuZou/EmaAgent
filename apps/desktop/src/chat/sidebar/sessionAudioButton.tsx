import { memo, type JSX } from 'react';
import { IconButton, Tooltip } from '@ema-agent/ui';
import { usePlaybackStore } from '../speech/turnSpeechPlayback.js';

export const SessionAudioButton = memo(function SessionAudioButton({ sessionId, onStopPlayback }: {
  readonly sessionId: string;
  readonly onStopPlayback: () => void;
}): JSX.Element | null {
  const status = usePlaybackStore(state => state.queue[0]?.sessionId === sessionId ? state.playbackStatus : null);
  if (!status) return null;
  return (
    <Tooltip content={status === 'loading' ? '正在准备播放, 点击停止; 后台生成继续' : '正在播放, 点击停止; 后台生成继续'}>
      <IconButton
        size="sm"
        variant="ghost"
        label="停止该会话的播放"
        className="ema-session-audio-button shrink-0"
        iconNode={
          <>
            <span
              className={status === 'loading' ? 'ema-session-audio-state i-lucide:loader-circle' : 'ema-session-audio-state i-lucide:volume-2'}
              data-loading={status === 'loading' || undefined}
            />
            <span className="ema-session-audio-stop i-ema:stop" />
          </>
        }
        onClick={event => {
          event.stopPropagation();
          onStopPlayback();
        }}
      />
    </Tooltip>
  );
});
