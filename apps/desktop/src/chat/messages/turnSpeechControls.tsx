import type { JSX } from 'react';
import { DropdownMenu, IconButton, Tooltip, type MenuItem } from '@ema-agent/ui';
import { sessionPresentation } from '../presentation/sessionPresentation.js';
import { replayTurn, stopTurnPlayback, usePlaybackStore } from '../speech/turnSpeechPlayback.js';
import {
  cancelTurnSpeechGeneration,
  generateTurnSpeech,
  useSpeechGenerationStore,
} from '../speech/turnSpeechGeneration.js';

export function TurnSpeechControls({ sessionId, turnId, audioAvailable, canGenerate }: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly audioAvailable: boolean;
  readonly canGenerate: boolean;
}): JSX.Element {
  const playbackStatus = usePlaybackStore(state => {
    const key = state.queue[0];
    return key?.sessionId === sessionId && key.turnId === turnId ? state.playbackStatus : null;
  });
  const queued = usePlaybackStore(state => state.queue.some((key, index) => index > 0
    && key.sessionId === sessionId && key.turnId === turnId));
  const generation = useSpeechGenerationStore(state => state.active.get(turnId));
  const canStartGeneration = canGenerate && !generation;

  const generate = (): void => {
    sessionPresentation.removePendingTurn(sessionId, turnId);
    void generateTurnSpeech(sessionId, turnId);
  };
  const menuItems: MenuItem[] = [
    {
      kind: 'item',
      label: '播放现有语音',
      icon: 'i-lucide:volume-2',
      description: '替换当前播放和待播列表, 后台生成继续',
      onSelect: () => replayTurn(sessionId, turnId),
    },
    {
      kind: 'item',
      label: '重新生成整轮语音',
      icon: 'i-lucide:refresh-cw',
      description: '生成并保存, 完成后不会自动播放',
      onSelect: generate,
    },
  ];

  let audioButton: JSX.Element | null = null;
  if (playbackStatus) {
    audioButton = (
      <Tooltip content={playbackStatus === 'loading' ? '停止播放 (正在加载), 后台生成继续' : '停止播放, 后台生成继续'}>
        <IconButton
          size="sm"
          variant="ghost"
          shape="rounded"
          label="停止播放"
          icon="i-ema:stop"
          className="ema-chat-icon-btn chat-message-action text-[var(--ema-primary)]"
          onClick={() => stopTurnPlayback(sessionId, turnId)}
        />
      </Tooltip>
    );
  } else if (audioAvailable && canStartGeneration) {
    audioButton = (
      <DropdownMenu
        side="top"
        items={menuItems}
        triggerTooltip={queued ? '语音操作 (已排队等待播放)' : '语音操作'}
        trigger={
          <IconButton
            size="sm"
            variant="ghost"
            shape="rounded"
            label="语音操作"
            icon="i-lucide:volume-2"
            className="ema-chat-icon-btn chat-message-action"
          />
        }
      />
    );
  } else if (audioAvailable) {
    audioButton = (
      <Tooltip content={queued ? '播放现有语音 (替换当前播放和待播列表)' : '播放现有语音'}>
        <IconButton
          size="sm"
          variant="ghost"
          shape="rounded"
          label="播放现有语音"
          icon="i-lucide:volume-2"
          className="ema-chat-icon-btn chat-message-action"
          onClick={() => replayTurn(sessionId, turnId)}
        />
      </Tooltip>
    );
  } else if (canStartGeneration) {
    audioButton = (
      <Tooltip content="生成整轮语音并保存, 完成后手动播放">
        <IconButton
          size="sm"
          variant="ghost"
          shape="rounded"
          label="生成语音"
          icon="i-lucide:volume-2"
          className="ema-chat-icon-btn chat-message-action"
          onClick={generate}
        />
      </Tooltip>
    );
  }

  return (
    <>
      {audioButton}
      {generation && (
        <Tooltip content={generation.cancelling ? '正在取消语音生成…' : '正在生成语音, 点击取消生成'}>
          <IconButton
            size="sm"
            variant="ghost"
            shape="rounded"
            label={generation.cancelling ? '正在取消语音生成' : '取消语音生成'}
            disabled={generation.cancelling}
            iconNode={
              <>
                <span className="ema-speech-generation-icon i-lucide:loader-circle" />
                {!generation.cancelling && <span className="ema-speech-generation-stop i-ema:stop" />}
              </>
            }
            className="ema-chat-icon-btn chat-message-action ema-speech-cancel-generation"
            onClick={() => void cancelTurnSpeechGeneration(turnId)}
          />
        </Tooltip>
      )}
    </>
  );
}
