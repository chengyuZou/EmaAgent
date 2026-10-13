import { useEffect, useState, type JSX } from 'react';
import { DropdownMenu, IconButton, Tooltip, type MenuItem } from '@ema-agent/ui';
import { turnsApi, type TurnAudioRecords } from '../../api/turns.js';
import { subscribeSystemEvent } from '../../lib/events/systemEventDispatcher.js';
import { useCharacterStore } from '../../stores/character.js';
import { sessionPresentation } from '../presentation/sessionPresentation.js';
import { replayTurn, stopTurnPlayback, usePlaybackStore } from '../speech/turnSpeechPlayback.js';
import {
  cancelTurnSpeechGeneration,
  generateTurnSpeech,
  useSpeechGenerationStore,
} from '../speech/turnSpeechGeneration.js';

interface TurnSpeechControlsProps {
  readonly sessionId: string;
  readonly turnId: string;
}

export function TurnSpeechControls({
  sessionId,
  turnId,
}: TurnSpeechControlsProps): JSX.Element {
  const playbackStatus = usePlaybackStore(state => {
    const key = state.queue[0];
    return key?.sessionId === sessionId && key.turnId === turnId ? state.playbackStatus : null;
  });
  const queued = usePlaybackStore(state => state.queue.some((key, index) => (
    index > 0 && key.sessionId === sessionId && key.turnId === turnId
  )));
  const generation = useSpeechGenerationStore(state => state.active.get(turnId));
  const characters = useCharacterStore(state => state.characters);
  const activeName = useCharacterStore(state => state.activeName);
  const [menuOpen, setMenuOpen] = useState(false);
  const [details, setDetails] = useState<TurnAudioRecords | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    let controller: AbortController | undefined;
    const refresh = (): void => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setDetails(null);
      setError(null);
      void turnsApi.getAudioRecords(turnId, request.signal).then(result => {
        if (!request.signal.aborted) setDetails(result);
      }).catch(cause => {
        if (!request.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '音频信息读取失败');
        }
      });
    };
    refresh();
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'session_audio_changed' && event.turnId === turnId) {
        refresh();
      } else if (event.type === 'model_bindings_changed' || event.type === 'provider_config_changed') {
        refresh();
      } else if ((event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_aborted')
        && event.turnId === turnId) {
        refresh();
      }
    });
    return () => {
      controller?.abort();
      unsubscribe();
    };
  }, [menuOpen, turnId, characters, activeName]);

  // 切换角色后不能先显示上一个角色的结果, 等菜单查询返回新的角色事实.
  const current = details?.currentCharacter.characterName === activeName ? details.currentCharacter : null;
  const saved = current && details?.records.some(record => record.characterName === current.characterName);
  const loadingReason = error ?? '正在读取当前角色的音频…';
  let playbackDescription = loadingReason;
  let generationDescription = loadingReason;
  if (current) {
    playbackDescription = saved
      ? `播放${current.characterName}的音频, 替换当前播放和待播列表`
      : `当前角色${current.characterName}没有生成的音频`;
    generationDescription = '生成并保存, 完成后不会自动播放';
    if (generation) {
      generationDescription = '该轮正在生成语音, 请等待完成或先取消';
    } else if (current.unavailableReason) {
      generationDescription = current.unavailableReason;
    }
  }

  const generate = (): void => {
    sessionPresentation.removePendingTurn(sessionId, turnId);
    void generateTurnSpeech(sessionId, turnId);
  };
  const menuItems: MenuItem[] = [
    {
      kind: 'item',
      label: '播放音频',
      icon: 'i-lucide:volume-2',
      disabled: !saved,
      description: playbackDescription,
      onSelect: () => replayTurn(sessionId, turnId),
    },
    {
      kind: 'item',
      label: saved ? '重新生成音频' : '生成音频',
      icon: 'i-lucide:refresh-cw',
      disabled: !current || current.unavailableReason !== null || Boolean(generation),
      description: generationDescription,
      onSelect: generate,
    },
  ];

  return (
    <>
      {playbackStatus ? (
        <Tooltip content="停止播放, 后台生成继续">
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
      ) : (
        <DropdownMenu
          side="top"
          items={menuItems}
          onOpenChange={setMenuOpen}
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
      )}
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
                {!generation.cancelling && (
                  <span className="ema-speech-generation-stop i-ema:stop" />
                )}
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
