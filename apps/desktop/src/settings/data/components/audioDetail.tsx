import { memo, useCallback, useEffect, useState, type JSX } from 'react';
import { Button, DropdownMenu, IconButton, Skeleton, Tooltip, type MenuItem } from '@ema-agent/ui';
import { sessionsApi, type SessionAudioPage } from '../../../api/sessions.js';
import { turnsApi, type TurnAudioRecords } from '../../../api/turns.js';
import {
  cancelTurnSpeechGeneration,
  generateTurnSpeech,
  useSpeechGenerationStore,
} from '../../../chat/speech/turnSpeechGeneration.js';
import { useCollapsibleBody } from '../../../chat/messages/messageExpansion.js';
import { useCharacterStore } from '../../../stores/character.js';
import { AudioPlayer } from '../../../lib/audio/audioPlayer.js';
import { tauriBridge } from '../../../lib/tauri/tauriBridge.js';
import { showToast } from '../../../lib/notifications/toast.js';
import { subscribeSystemEvent } from '../../../lib/events/systemEventDispatcher.js';
import { fmtBytes, fmtDateFull, fmtDuration } from '../storageFormat.js';
import { useDetailPages } from '../useDetailPages.js';

type TurnAudioSummary = SessionAudioPage['items'][number];
type SavedAudio = TurnAudioRecords['records'][number];

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
  const [openId, setOpenId] = useState<string | null>(null);
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
    setOpenId(current => current === turnId ? null : turnId);
  }, []);

  return (
    <section className="flex flex-col gap-2" aria-label="音频记录">
      <p className="mb-1 text-xs text-[var(--ema-text-tertiary)]">
        按轮次查看各角色保存的语音 · 普通文件试听，不驱动口型
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
          {items.map(audio => (
            <AudioRow
              key={audio.turnId}
              sessionId={sessionId}
              audio={audio}
              open={audio.turnId === openId}
              active={active}
              onToggle={toggle}
            />
          ))}
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
  const characters = useCharacterStore(state => state.characters);
  const generation = useSpeechGenerationStore(state => state.active.get(audio.turnId));
  const [menuOpen, setMenuOpen] = useState(false);
  const [details, setDetails] = useState<TurnAudioRecords | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!active || (!open && !menuOpen)) return;
    let controller: AbortController | undefined;
    const refresh = (): void => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setLoading(true);
      setError(null);
      void turnsApi.getAudioRecords(audio.turnId, request.signal).then(result => {
        if (!request.signal.aborted) {
          setDetails(result);
        }
      }).catch(cause => {
        if (!request.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '该轮音频读取失败');
        }
      }).finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });
    };
    refresh();
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'session_audio_changed' && event.turnId === audio.turnId) {
        refresh();
      } else if (event.type === 'model_bindings_changed' || event.type === 'provider_config_changed') {
        refresh();
      } else if ((event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_aborted')
        && event.turnId === audio.turnId) {
        refresh();
      }
    });
    return () => {
      controller?.abort();
      unsubscribe();
    };
  }, [audio.turnId, active, open, menuOpen, characters, revision]);

  let menuItems: MenuItem[];
  if (!details || loading || error) {
    menuItems = [{
      kind: 'item',
      label: '重新生成音频',
      disabled: true,
      description: error ?? '正在读取可用角色…',
      onSelect: () => {},
    }];
  } else if (details.generationChoices.length === 0) {
    menuItems = [{
      kind: 'item',
      label: '暂无可用角色',
      disabled: true,
      description: '请先为角色选用主参考音频',
      onSelect: () => {},
    }];
  } else {
    menuItems = details.generationChoices.map(choice => ({
      kind: 'item',
      id: choice.characterName,
      label: choice.characterName,
      icon: 'i-lucide:audio-lines',
      disabled: choice.unavailableReason !== null || Boolean(generation),
      description: generation
        ? '该轮正在生成语音, 请等待完成或先取消'
        : choice.unavailableReason ?? '生成并保存该角色的音频, 不自动播放',
      onSelect: () => void generateTurnSpeech(sessionId, audio.turnId, choice.characterName),
    }));
  }

  return (
    <article className="ema-turn-audio-row overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      <div className="ema-turn-audio-heading">
        <button
          type="button"
          className="ema-turn-audio-toggle"
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
              {fmtDateFull(audio.createdAt)} · {audio.audioCount} 个角色音频
              {audio.audioCount > 0 && (
                <> · {fmtDuration(audio.totalDurationMs)} · {fmtBytes(audio.totalByteSize)}</>
              )}
              {audio.status !== 'completed' && <> · 回复未完成</>}
            </span>
          </span>
          <span
            className="i-lucide:chevron-down shrink-0 text-xs transition-transform duration-[var(--ema-duration-base)]"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
            aria-hidden
          />
        </button>
        <div className="ema-turn-audio-actions">
          {generation && (
            <Tooltip content={generation.cancelling ? '正在取消语音生成…' : '取消该轮语音生成, 原有音频保留'}>
              <IconButton
                label={generation.cancelling ? '正在取消语音生成' : '取消语音生成'}
                icon="i-ema:stop"
                size="sm"
                variant="ghost"
                shape="rounded"
                disabled={generation.cancelling}
                onClick={() => void cancelTurnSpeechGeneration(audio.turnId)}
              />
            </Tooltip>
          )}
          <DropdownMenu
            align="end"
            items={menuItems}
            onOpenChange={setMenuOpen}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                icon={generation ? 'i-lucide:loader-circle' : 'i-lucide:refresh-cw'}
                loading={Boolean(generation)}
                disabled={Boolean(generation)}
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
              {!details && loading && <Skeleton className="h-24 rounded-lg" />}
              {error && (
                <div className="flex items-center gap-2">
                  <p className="text-xs text-[var(--ema-danger)]">{error}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRevision(current => current + 1)}
                  >
                    重试
                  </Button>
                </div>
              )}
              {details?.records.length === 0 && (
                <p className="py-3 text-xs text-[var(--ema-text-tertiary)]">
                  该轮尚未保存音频, 可从右上角选择角色生成
                </p>
              )}
              {details?.records.map(record => (
                <SavedAudioPlayer
                  key={`${record.storagePath}:${record.createdAt}`}
                  audio={record}
                  active={active && open}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
});

interface SavedAudioPlayerProps {
  readonly audio: SavedAudio;
  readonly active: boolean;
}

function SavedAudioPlayer({
  audio,
  active,
}: SavedAudioPlayerProps): JSX.Element {
  const revealAudio = async (): Promise<void> => {
    try {
      await tauriBridge.revealInFolder(audio.storagePath);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '无法在文件夹中显示音频', { variant: 'danger' });
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
        <span className="min-w-0 flex-1">
          {fmtDateFull(audio.createdAt)} · {fmtDuration(audio.durationMs)} · {fmtBytes(audio.byteSize)}
        </span>
        <Tooltip content={audio.storagePath} variant="card">
          <IconButton
            label="文件信息 / 在文件夹中显示"
            icon="i-lucide:folder-open"
            variant="ghost"
            shape="rounded"
            size="sm"
            onClick={() => void revealAudio()}
          />
        </Tooltip>
      </div>
      {/* 同一角色文件替换后才重建播放器, 别的版本或角色资源刷新不丢失播放进度. */}
      <AudioPlayer
        filePath={audio.storagePath}
        title={audio.characterName}
        active={active}
        className="ema-turn-audio-player"
      />
    </div>
  );
}
