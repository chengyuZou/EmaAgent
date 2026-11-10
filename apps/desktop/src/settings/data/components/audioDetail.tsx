import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, DropdownMenu, IconButton, Skeleton, Tooltip, type MenuItem } from '@ema-agent/ui';
import { sessionsApi, type SessionAudioPage } from '../../../api/sessions.js';
import { turnsApi, type SpeechAvailabilityList, type TurnAudioRecords } from '../../../api/turns.js';
import { useAudioStore, useTurnAudio } from '../../../stores/audio.js';
import { useCollapsibleBody } from '../../../chat/messages/messageExpansion.js';
import { AudioPlayer } from '../../../lib/audio/audioPlayer.js';
import { audioApi } from '../../../api/audio.js';
import { tauriBridge } from '../../../lib/tauri/tauriBridge.js';
import { showToast } from '../../../lib/notifications/toast.js';
import { subscribeSystemEvent } from '../../../lib/events/systemEventDispatcher.js';
import { fmtBytes, fmtDateFull, fmtDuration } from '../../../lib/resourceFormat.js';
import { useDetailPages } from '../useDetailPages.js';

type TurnAudioSummary = SessionAudioPage['items'][number];
type AudioSummary = TurnAudioRecords[number];

interface AudioSelectionContextValue {
  readonly selectedAudioId: string | null;
  readonly onSelectAudio: (audioId: string | null) => void;
}

// 每个 AudioDetail 提供自己的试听选择, 中间组件不保存或转传第二份状态.
const AudioSelectionContext = createContext<AudioSelectionContextValue | null>(null);

function useAudioSelection(): AudioSelectionContextValue {
  const selection = useContext(AudioSelectionContext);
  if (!selection) throw new Error('Audio selection requires AudioDetail');
  return selection;
}

interface AudioDetailProps {
  readonly sessionId: string;
  readonly active: boolean;
}

interface AudioRowProps extends AudioDetailProps {
  readonly audio: TurnAudioSummary;
  readonly open: boolean;
  readonly onToggle: (turnId: string) => void;
}

const audioId = (audio: TurnAudioSummary): string => audio.turnId;

export function AudioDetail({
  sessionId,
  active,
}: AudioDetailProps): JSX.Element {
  const [openTurnId, setOpenTurnId] = useState<string | null>(null);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const audioSelection = useMemo(() => ({ selectedAudioId, onSelectAudio: setSelectedAudioId }), [selectedAudioId]);
  useEffect(() => {
    // 主窗口切换页面时会保留组件, 必须取消旧选择, 否则重新展开录音会再次自动试听.
    if (!active) setSelectedAudioId(null);
  }, [active]);
  const readPage = useCallback((
    before: SessionAudioPage['nextCursor'] | undefined,
    signal: AbortSignal,
  ) => {
    return sessionsApi.listAudio(sessionId, before ?? undefined, signal);
  }, [sessionId]);
  const { items, cursor, loading, loadingMore, failed, refresh, loadMore } = useDetailPages(readPage, audioId);

  useEffect(() => subscribeSystemEvent(event => {
    if ((event.type === 'session_audio_changed' || event.type === 'session_list_changed'
      || event.type === 'turn_started' || event.type === 'turn_completed'
      || event.type === 'turn_failed' || event.type === 'turn_aborted')
      && event.sessionId === sessionId) {
      refresh();
    }
  }), [sessionId, refresh]);

  const toggle = useCallback((turnId: string) => {
    setSelectedAudioId(null);
    setOpenTurnId(current => current === turnId ? null : turnId);
  }, []);

  return (
    <section className="flex flex-col gap-2" aria-label="音频记录">
      <p className="mb-1 text-xs text-[var(--ema-text-tertiary)]">
        按轮次查看各角色保存的语音 | 普通文件试听, 不驱动口型
      </p>
      {failed && (
        <div className="flex items-center gap-2 py-3">
          <p className="text-xs text-[var(--ema-danger)]">音频目录读取失败</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
          >
            重试
          </Button>
        </div>
      )}
      {loading ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : (
        <>
          {!failed && items.length === 0 && (
            <p className="py-6 text-center text-xs text-[var(--ema-text-tertiary)]">
              没有轮次记录
            </p>
          )}
          <AudioSelectionContext.Provider value={audioSelection}>
            {items.map(audio => (
              <AudioRow
                key={audio.turnId}
                sessionId={sessionId}
                audio={audio}
                open={audio.turnId === openTurnId}
                active={active}
                onToggle={toggle}
              />
            ))}
          </AudioSelectionContext.Provider>
          {cursor && (
            <Button
              variant="ghost"
              size="sm"
              loading={loadingMore}
              onClick={loadMore}
            >
              加载更早的轮次
            </Button>
          )}
        </>
      )}
    </section>
  );
}

const AudioRow = memo(function AudioRow({
  sessionId,
  audio,
  open,
  active,
  onToggle,
}: AudioRowProps): JSX.Element {
  const { containerRef, mounted } = useCollapsibleBody(open);
  // 筛选会创建数组, useShallow 在本 Turn 的生成对象未变时保留原引用, 避免重复更新.
  const generations = useAudioStore(useShallow(state => (
    [...state.generationsByTurnAndCharacter.values()]
      .filter(generation => generation.turnId === audio.turnId)
  )));
  const [menuOpen, setMenuOpen] = useState(false);
  const turnAudio = useTurnAudio(sessionId, audio.turnId, active && open);
  const audioRecords = turnAudio?.audioRecords;
  const loading = turnAudio?.readStatus === 'loading';
  const error = turnAudio?.readFailureMessage;
  const [speechAvailability, setSpeechAvailability] = useState<SpeechAvailabilityList | null>(null);
  const [availabilityFailureMessage, setAvailabilityFailureMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !menuOpen) return;
    let controller: AbortController | null = null;
    const readAvailability = async (): Promise<void> => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      setSpeechAvailability(null);
      setAvailabilityFailureMessage(null);
      try {
        const availability = await turnsApi.listSpeechAvailability(audio.turnId, requestController.signal);
        if (!requestController.signal.aborted) setSpeechAvailability(availability);
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
        && event.turnId === audio.turnId;
      if (hasConfigurationChange || hasTurnChange) void readAvailability();
    });
    // 生成菜单不持有录音列表, 关闭后也不接受旧的生成可用性查询结果.
    return () => {
      controller?.abort();
      unsubscribe();
    };
  }, [active, menuOpen, audio.turnId]);

  let menuItems: MenuItem[];
  if (!speechAvailability || availabilityFailureMessage) {
    menuItems = [{
      kind: 'item',
      label: '重新生成音频',
      disabled: true,
      description: availabilityFailureMessage ?? '正在读取可用角色...',
      onSelect: () => {},
    }];
  } else if (speechAvailability.length === 0) {
    menuItems = [{
      kind: 'item',
      label: '暂无可用角色',
      disabled: true,
      description: '请先为角色选用主参考音频',
      onSelect: () => {},
    }];
  } else {
    menuItems = speechAvailability.map(characterAvailability => {
      const isGenerating = generations.some(generation => (
        generation.characterName === characterAvailability.characterName
      ));
      return {
        kind: 'item',
        id: characterAvailability.characterName,
        label: characterAvailability.characterName,
        icon: 'i-lucide:audio-lines',
        disabled: characterAvailability.unavailableReason !== null || isGenerating,
        description: isGenerating
          ? '这个角色正在生成语音, 其他角色仍可生成'
          : characterAvailability.unavailableReason ?? '生成并保存该角色的音频, 不自动播放',
        onSelect: () => void useAudioStore.getState().generateTurnSpeech({
          sessionId, turnId: audio.turnId, characterName: characterAvailability.characterName,
        }),
      };
    });
  }

  return (
    <article className="ema-turn-audio-row overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      <div className="ema-turn-audio-heading">
        <Button
          variant="ghost"
          className="ema-turn-audio-toggle h-auto justify-start"
          onClick={() => onToggle(audio.turnId)}
          aria-expanded={open}
        >
          <span
            className="i-lucide:audio-lines shrink-0 text-lg text-[var(--ema-primary)]"
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <strong className="block truncate text-sm">Turn · {audio.turnId.slice(0, 8)}</strong>
            <span className="mt-1 block text-xs text-[var(--ema-text-tertiary)]">
              {fmtDateFull(audio.createdAt)} | {audio.audioCount} 条音频
              {audio.audioCount > 0 && (
                <> | {fmtDuration(audio.totalDurationMs)} | {fmtBytes(audio.totalByteSize)}</>
              )}
              {audio.status !== 'completed' && <> | 回复未完成</>}
            </span>
          </span>
          <span
            className="i-lucide:chevron-down shrink-0 text-xs transition-transform duration-[var(--ema-duration-base)]"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
            aria-hidden
          />
        </Button>
        <div className="ema-turn-audio-actions">
          {generations.map(generation => (
            <Tooltip
              key={generation.characterName}
              content={generation.generationStatus === 'cancelling' ? '正在取消' : '取消 ' + generation.characterName + ' 的本次语音'}
            >
              <IconButton
                label={'取消 ' + generation.characterName + ' 的语音生成'}
                icon="i-ema:stop"
                size="sm"
                variant="ghost"
                disabled={!generation.audioId || generation.generationStatus === 'cancelling'}
                onClick={() => {
                  if (generation.audioId) void useAudioStore.getState().cancelSpeechGeneration(generation.audioId);
                }}
              />
            </Tooltip>
          ))}
          <DropdownMenu
            align="end"
            items={menuItems}
            onOpenChange={isOpen => {
              setMenuOpen(isOpen);
              setSpeechAvailability(null);
              setAvailabilityFailureMessage(null);
            }}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                icon="i-lucide:refresh-cw"
              >
                重新生成音频
              </Button>
            }
          />
        </div>
      </div>
      <div
        ref={containerRef}
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          {mounted && (
            <div className="flex flex-col gap-4 border-t border-[var(--ema-border)] p-4">
              {!audioRecords && loading && <Skeleton className="h-24 rounded-lg" />}
              {error && (
                <div className="flex items-center gap-2">
                  <p className="text-xs text-[var(--ema-danger)]">{error}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void useAudioStore.getState().refreshTurnAudio(audio.turnId)}
                  >
                    重试
                  </Button>
                </div>
              )}
              {audioRecords?.length === 0 && (
                <p className="py-3 text-xs text-[var(--ema-text-tertiary)]">
                  该轮尚未保存音频, 可从右上角选择角色生成
                </p>
              )}
              {Array.from(new Set(audioRecords?.map(record => record.characterName) ?? [])).map(characterName => (
                <CharacterAudioGroup
                  key={characterName}
                  sessionId={sessionId}
                  turnId={audio.turnId}
                  characterName={characterName}
                  audios={audioRecords!.filter(record => record.characterName === characterName)}
                  active={active && open && !error}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
});

interface CharacterAudioGroupProps {
  readonly sessionId: string;
  readonly turnId: string;
  readonly characterName: string;
  readonly audios: readonly AudioSummary[];
  readonly active: boolean;
}

function CharacterAudioGroup({
  sessionId, turnId, characterName, audios, active,
}: CharacterAudioGroupProps): JSX.Element {
  const { selectedAudioId, onSelectAudio } = useAudioSelection();
  const [isOpen, setIsOpen] = useState(false);
  const { containerRef, mounted } = useCollapsibleBody(isOpen);
  const toggleCharacter = (): void => {
    if (isOpen && audios.some(audio => audio.audioId === selectedAudioId)) onSelectAudio(null);
    setIsOpen(!isOpen);
  };
  return (
    <section className="rounded-lg border border-[var(--ema-border)]">
      <Button
        variant="ghost"
        className="w-full justify-between"
        aria-expanded={isOpen}
        onClick={toggleCharacter}
      >
        <span>{characterName} | {audios.length} 条音频</span>
        <span
          className="i-lucide:chevron-down transition-transform"
          style={{ transform: isOpen ? 'rotate(180deg)' : undefined }}
          aria-hidden
        />
      </Button>
      <div
        ref={containerRef}
        className="ema-collapsible"
        style={{ gridTemplateRows: isOpen ? '1fr' : '0fr', opacity: isOpen ? 1 : 0 }}
      >
        <div>
          {mounted && (
            <div className="flex flex-col gap-2 border-t border-[var(--ema-border)] p-2">
              {audios.map(audio => (
                <AudioSummaryRow
                  key={audio.audioId}
                  sessionId={sessionId}
                  turnId={turnId}
                  audio={audio}
                  active={active && isOpen}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

interface AudioSummaryRowProps {
  readonly sessionId: string;
  readonly turnId: string;
  readonly audio: AudioSummary;
  readonly active: boolean;
}

const AUDIO_STATUS_LABELS = {
  generating: '正在生成',
  ready: '可以播放',
  deleting: '正在删除',
  failed: '处理失败, 可重试清理',
};

function AudioSummaryRow({
  sessionId,
  turnId,
  audio,
  active,
}: AudioSummaryRowProps): JSX.Element | null {
  const { selectedAudioId, onSelectAudio } = useAudioSelection();
  const isSelected = audio.audioId === selectedAudioId;
  const isDeleting = useAudioStore(state => state.deletionRequests.has(audio.audioId));
  const [playbackUrl, setPlaybackUrl] = useState<string>();
  const canPlay = active && audio.audioStatus === 'ready' && !isDeleting;
  const isDeletionBlocked = isDeleting || audio.audioStatus === 'deleting';
  const failureMessage = audio.failureMessage;

  useEffect(() => {
    if (!isSelected || !canPlay || !active) {
      setPlaybackUrl(undefined);
      return;
    }
    let isRequestCurrent = true;
    void audioApi.audioUrl(audio.audioId).then(audioUrl => {
      if (isRequestCurrent) setPlaybackUrl(audioUrl);
    }).catch(error => {
      if (isRequestCurrent) showToast(error instanceof Error ? error.message : '无法取得播放地址', { variant: 'danger' });
    });
    return () => { isRequestCurrent = false; };
  }, [audio.audioId, isSelected, canPlay, active]);

  const revealAudio = async (): Promise<void> => {
    try {
      const audioRecord = await audioApi.loadAudioRecord(audio.audioId);
      await tauriBridge.revealInFolder(audioRecord.storagePath);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法在文件夹中显示音频', { variant: 'danger' });
    }
  };

  return (
    <div className="rounded-lg border border-[var(--ema-border)] p-2" data-audio-id={audio.audioId}>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start p-0 text-left"
          disabled={!canPlay}
          aria-label={'播放音频 ' + audio.audioId}
          onClick={() => onSelectAudio(audio.audioId)}
        >
          <span className="flex min-w-0 flex-col">
            <span className="block truncate text-xs">音频 {audio.audioId.slice(0, 8)} | {fmtDateFull(audio.createdAtMs)}</span>
            <span className="mt-1 block text-xs text-[var(--ema-text-tertiary)]">
              {isDeleting ? '正在删除' : AUDIO_STATUS_LABELS[audio.audioStatus]}
              {audio.durationMs !== null && <> | {fmtDuration(audio.durationMs)}</>}
              {audio.fileSizeBytes !== null && <> | {fmtBytes(audio.fileSizeBytes)}</>}
            </span>
          </span>
        </Button>
        <Tooltip content="在文件夹中显示">
          <IconButton
            label="在文件夹中显示音频"
            icon="i-lucide:folder-open"
            variant="ghost"
            size="sm"
            disabled={isDeletionBlocked}
            onClick={() => void revealAudio()}
          />
        </Tooltip>
        {audio.audioStatus === 'generating' && (
          <Tooltip content="取消这条音频的生成">
            <IconButton
              label={'取消音频生成 ' + audio.audioId}
              icon="i-ema:stop"
              variant="ghost"
              size="sm"
              onClick={() => void useAudioStore.getState().cancelSpeechGeneration(audio.audioId)}
            />
          </Tooltip>
        )}
        <Tooltip content={audio.audioStatus === 'generating' ? '请先取消生成' : '删除这条音频'}>
          <IconButton
            label={'删除音频 ' + audio.audioId}
            icon={isDeleting ? 'i-lucide:loader-circle' : 'i-lucide:trash-2'}
            iconNode={isDeleting ? <span className="i-lucide:loader-circle animate-spin" aria-hidden /> : undefined}
            variant="ghost"
            size="sm"
            disabled={isDeletionBlocked || audio.audioStatus === 'generating'}
            onClick={() => void useAudioStore.getState().deleteAudio({ sessionId, turnId, audioId: audio.audioId })}
          />
        </Tooltip>
      </div>
      {failureMessage && <p className="mt-2 text-xs text-[var(--ema-danger)]">{failureMessage}</p>}
      {isSelected && canPlay && active && playbackUrl && (
        <AudioPlayer
          key={audio.audioId}
          src={playbackUrl}
          title={audio.characterName + ' | ' + audio.audioId.slice(0, 8)}
          active={active}
          shouldAutoPlay
          className="ema-turn-audio-player"
        />
      )}
    </div>
  );
}
