import { memo, useCallback, useEffect, useState, type JSX } from 'react';
import { Button, IconButton, Skeleton, Tooltip } from '@ema-agent/ui';
import { sessionsApi, type SessionAudioPage } from '../../../api/sessions.js';
import { turnsApi } from '../../../api/turns.js';
import { AudioPlayer } from '../../../lib/audio/audioPlayer.js';
import { useCollapsibleBody } from '../../../chat/messages/messageExpansion.js';
import { fmtBytes, fmtDateFull, fmtDuration } from '../storageFormat.js';
import { tauriBridge } from '../../../lib/tauriBridge.js';
import { showToast } from '../../../lib/notifications/toast.js';
import { useDetailPages } from '../useDetailPages.js';
import { subscribeSystemEvent } from '../../../lib/events/systemEventDispatcher.js';

type SavedAudio = SessionAudioPage['items'][number];
const audioId = (audio: SavedAudio): string => audio.turnId;

export function AudioDetail({ sessionId, active }: { readonly sessionId: string; readonly active: boolean }): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const readPage = useCallback((before: SessionAudioPage['nextCursor'] | undefined, signal: AbortSignal) => {
    return sessionsApi.listAudio(sessionId, before ?? undefined, signal);
  }, [sessionId]);
  const { items, cursor, loading, loadingMore, failed, refresh, loadMore } = useDetailPages(readPage, audioId);
  useEffect(() => subscribeSystemEvent(event => {
    if (
      (event.type === 'session_audio_changed' || event.type === 'session_list_changed')
      && event.sessionId === sessionId
    ) {
      refresh();
    }
  }), [sessionId, refresh]);
  const toggle = useCallback((turnId: string) => {
    setOpenId(current => current === turnId ? null : turnId);
  }, []);
  return (
    <section className="flex flex-col gap-2" aria-label="音频记录">
      <p className="mb-1 text-xs text-[var(--ema-text-tertiary)]">各轮保存的语音 · 普通文件试听，不驱动口型</p>
      {failed && (
        <div className="flex items-center gap-2 py-3">
          <p className="text-xs text-[var(--ema-danger)]">音频目录读取失败</p>
          <Button variant="ghost" size="sm" onClick={refresh}>
            重试
          </Button>
        </div>
      )}
      {loading ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : (
        <>
          {!failed && items.length === 0 && (
            <p className="py-6 text-center text-xs text-[var(--ema-text-tertiary)]">没有已保存的音频</p>
          )}
          {items.map(audio => (
            <AudioRow
              key={audio.turnId}
              audio={audio}
              open={audio.turnId === openId}
              active={active}
              onToggle={toggle}
            />
          ))}
          {cursor && (
            <Button variant="ghost" size="sm" loading={loadingMore} onClick={loadMore}>
              加载更早的音频
            </Button>
          )}
        </>
      )}
    </section>
  );
}

const AudioRow = memo(function AudioRow({ audio, open, active, onToggle }: {
  readonly audio: SavedAudio;
  readonly open: boolean;
  readonly active: boolean;
  readonly onToggle: (turnId: string) => void;
}): JSX.Element {
  const { containerRef, mounted } = useCollapsibleBody(open);
  async function revealAudio(): Promise<void> {
    try {
      await tauriBridge.revealInFolder(audio.storagePath);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '无法在文件夹中显示音频', { variant: 'danger' });
    }
  }
  return (
    <article className="overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      <div className="flex items-center gap-1 pr-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--ema-surface-2)]"
          onClick={() => onToggle(audio.turnId)}
          aria-expanded={open}
        >
          <span className="i-lucide:audio-lines shrink-0 text-lg text-[var(--ema-primary)]" aria-hidden />
          <span className="min-w-0 flex-1">
            <strong className="block truncate text-sm">Turn · {audio.turnId.slice(0, 8)}</strong>
            <span className="mt-1 block text-xs text-[var(--ema-text-tertiary)]">
              {fmtDateFull(audio.createdAt)} · 音频时长 {fmtDuration(audio.durationMs)} · {fmtBytes(audio.byteSize)}
            </span>
          </span>
          <span
            className="i-lucide:chevron-down text-xs transition-transform duration-[var(--ema-duration-base)]"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
            aria-hidden
          />
        </button>
        <Tooltip content={audio.storagePath} variant="card">
          <IconButton
            label="在文件夹中显示音频"
            icon="i-lucide:folder-open"
            variant="ghost"
            shape="rounded"
            size="sm"
            onClick={() => void revealAudio()}
          />
        </Tooltip>
      </div>
      <div
        ref={containerRef}
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          {mounted && (
            <div className="border-t border-[var(--ema-border)] p-4">
              <p className="mb-3 break-all font-mono text-xs text-[var(--ema-text-tertiary)]">
                {audio.storagePath}
              </p>
              {/* 同一文件重新生成后才重建播放器. 其他音频目录更新不丢弃当前播放进度. */}
              <SavedAudioPlayer key={audio.createdAt} turnId={audio.turnId} active={active && open} />
            </div>
          )}
        </div>
      </div>
    </article>
  );
});

function SavedAudioPlayer({ turnId, active }: { readonly turnId: string; readonly active: boolean }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let mounted = true;
    setFailed(false);
    // 只取得现有的音频地址. 文件由播放器按需读取, 不在这里下载整轮 Blob 或 AudioBuffer.
    void turnsApi.audioUrl(turnId).then(url => {
      if (mounted) {
        setSrc(url);
      }
    }).catch(() => {
      if (mounted) {
        setFailed(true);
      }
    });
    return () => {
      mounted = false;
    };
  }, [turnId, revision]);
  if (failed) {
    return (
      <div className="flex items-center gap-2">
        <p className="text-xs text-[var(--ema-danger)]">音频地址读取失败</p>
        <Button variant="ghost" size="sm" onClick={() => setRevision(current => current + 1)}>
          重试
        </Button>
      </div>
    );
  }
  if (!src) {
    return <Skeleton className="h-24 rounded-lg" />;
  }
  return (
    <AudioPlayer
      src={src}
      title={`Turn · ${turnId.slice(0, 8)}`}
      active={active}
      className={"w-full"}
    />
  );
}
