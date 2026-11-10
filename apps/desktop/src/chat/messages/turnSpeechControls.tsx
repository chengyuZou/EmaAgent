import { useEffect, useState, type JSX } from 'react';
import { DropdownMenu, IconButton, Tooltip, type MenuItem } from '@ema-agent/ui';
import { useCharacterStore } from '../../stores/character.js';
import { audioGenerationKey, useAudioStore, useTurnAudio } from '../../stores/audio.js';
import { useAudioPlaybackStore } from '../../stores/audioPlayback.js';
import { MainView, useMainNavigationStore } from '../../layout/navigation.js';
import { fmtBytes, fmtDateFull, fmtDuration } from '../../lib/resourceFormat.js';
import { turnsApi, type CharacterSpeechAvailability } from '../../api/turns.js';
import { subscribeSystemEvent } from '../../lib/events/systemEventDispatcher.js';

interface TurnSpeechControlsProps {
  readonly sessionId: string;
  readonly turnId: string;
}

export function TurnSpeechControls({
  sessionId,
  turnId,
}: TurnSpeechControlsProps): JSX.Element {
  const playbackStatus = useAudioPlaybackStore(state =>
    state.owner?.sessionId === sessionId && state.owner.turnId === turnId ? state.playbackStatus : null);
  const activeName = useCharacterStore(state => state.activeName);
  const generation = useAudioStore(state => activeName
    ? state.generationsByTurnAndCharacter.get(audioGenerationKey(turnId, activeName))
    : undefined);
  const deletionRequests = useAudioStore(state => state.deletionRequests);
  const [menuOpen, setMenuOpen] = useState(false);
  const isVisible = useMainNavigationStore(state =>
    state.activeView === MainView.Chat && state.viewedSessionId === sessionId);
  const turnAudio = useTurnAudio(sessionId, turnId, isVisible && menuOpen);
  const audioRecords = turnAudio?.audioRecords;
  const error = turnAudio?.readFailureMessage;
  const isReading = turnAudio?.readStatus !== 'ready';
  const [availability, setAvailability] = useState<CharacterSpeechAvailability | null>(null);
  const [availabilityFailureMessage, setAvailabilityFailureMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpen || !isVisible || !activeName) return;
    let controller: AbortController | null = null;
    const readAvailability = async (): Promise<void> => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      setAvailability(null);
      setAvailabilityFailureMessage(null);
      try {
        const characterAvailability = await turnsApi.getCharacterSpeechAvailability(turnId, activeName, requestController.signal);
        if (!requestController.signal.aborted) setAvailability(characterAvailability);
      } catch (error) {
        if (!requestController.signal.aborted) {
          setAvailabilityFailureMessage(error instanceof Error ? error.message : '语音生成可用性读取失败');
        }
      }
    };
    void readAvailability();
    const unsubscribe = subscribeSystemEvent(event => {
      const hasConfigurationChange = event.type === 'character_resources_changed'
        || event.type === 'model_bindings_changed' || event.type === 'provider_config_changed';
      const hasTurnChange = (event.type === 'session_audio_changed' || event.type === 'turn_started'
        || event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_aborted')
        && event.turnId === turnId;
      if (hasConfigurationChange || hasTurnChange) void readAvailability();
    });
    // 菜单关闭, 切换角色或页面隐藏后, 旧查询不能恢复此前角色的按钮状态.
    return () => {
      controller?.abort();
      unsubscribe();
    };
  }, [menuOpen, isVisible, activeName, turnId]);

  const current = availability?.characterName === activeName ? availability : null;
  const playableAudios = !error ? audioRecords?.filter(audio => (
    audio.characterName === activeName && audio.audioStatus === 'ready' && !deletionRequests.has(audio.audioId)
  )) ?? [] : [];
  const isGenerating = Boolean(generation) || Boolean(audioRecords?.some(record =>
    record.characterName === activeName && record.audioStatus === 'generating'));
  const saved = playableAudios.length > 0;
  const loadingReason = error ?? '正在读取当前角色的音频…';
  let playbackDescription = loadingReason;
  let generationDescription = availabilityFailureMessage ?? '正在读取当前角色的生成可用性...';
  if (!isReading && activeName) {
    playbackDescription = saved
      ? `播放${activeName}的音频, 替换当前播放`
      : `当前角色${activeName}没有生成的音频`;
  }
  if (current) {
    generationDescription = '生成并保存, 完成后不会自动播放';
    if (isGenerating) {
      generationDescription = '该轮正在生成语音, 请等待完成或先取消';
    } else if (current.unavailableReason) {
      generationDescription = current.unavailableReason;
    }
  }

  const generate = (): void => {
    if (activeName) void useAudioStore.getState().generateTurnSpeech({ sessionId, turnId, characterName: activeName });
  };
  const menuItems: MenuItem[] = [
    {
      kind: 'submenu',
      id: 'play-audio',
      label: '播放音频',
      icon: 'i-lucide:volume-2',
      items: playableAudios.length > 0 ? playableAudios.map(audio => ({
        kind: 'item',
        id: audio.audioId,
        label: '音频 ' + audio.audioId.slice(0, 8),
        description: fmtDateFull(audio.createdAtMs) + ' | ' + fmtDuration(audio.durationMs!) + ' | ' + fmtBytes(audio.fileSizeBytes!),
        onSelect: () => { void useAudioPlaybackStore.getState().playSavedAudio({ sessionId, audioId: audio.audioId }); },
      })) : [{ kind: 'item', label: playbackDescription, disabled: true, onSelect: () => {} }],
    },
    {
      kind: 'item',
      label: saved ? '再生成一条音频' : '生成音频',
      icon: 'i-lucide:refresh-cw',
      disabled: !current || current.unavailableReason !== null || isGenerating,
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
            onClick={() => useAudioPlaybackStore.getState().stopPlayback()}
          />
        </Tooltip>
      ) : (
        <DropdownMenu
          side="top"
          items={menuItems}
          onOpenChange={open => {
            setMenuOpen(open);
            setAvailability(null);
            setAvailabilityFailureMessage(null);
          }}
          triggerTooltip="语音操作"
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
        <Tooltip content={(generation.generationStatus === 'cancelling') ? '正在取消语音生成…' : '正在生成语音, 点击取消生成'}>
          <IconButton
            size="sm"
            variant="ghost"
            shape="rounded"
            label={(generation.generationStatus === 'cancelling') ? '正在取消语音生成' : '取消语音生成'}
            disabled={generation.audioId === null || generation.generationStatus === 'cancelling'}
            iconNode={
              <>
                <span className="ema-speech-generation-icon i-lucide:loader-circle" />
                {!(generation.generationStatus === 'cancelling') && (
                  <span className="ema-speech-generation-stop i-ema:stop" />
                )}
              </>
            }
            className="ema-chat-icon-btn chat-message-action ema-speech-cancel-generation"
            onClick={() => generation.audioId && void useAudioStore.getState().cancelSpeechGeneration(generation.audioId)}
          />
        </Tooltip>
      )}
    </>
  );
}
