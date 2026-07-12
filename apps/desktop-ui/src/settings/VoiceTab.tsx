/**
 * VoiceTab — manage refAudios: upload, test listen, set primary, delete.
 */
import { useState, useRef, type CSSProperties, type JSX } from 'react';
import { Button, Checkbox, EntityRow, FilePicker, Select, Textarea } from '@ema-agent/ui';
import { useCardStore } from '../stores/card-store.js';
import { cardsApi } from '../api/cards.js';
import { showToast } from '../lib/toast.js';
import type { CharacterCardId } from '@ema-agent/contracts';
import type { CharacterVoiceProfile, CharacterRefAudio } from '@ema-agent/character-card';

const LANG_OPTIONS = [
  { value: 'zh', label: '中文 (zh)' },
  { value: 'en', label: 'English (en)' },
  { value: 'ja', label: '日本語 (ja)' },
];

export function VoiceTab({
  cardId,
  voiceProfile,
  isBuiltin,
}: {
  cardId:       CharacterCardId;
  voiceProfile: CharacterVoiceProfile;
  isBuiltin:    boolean;
}): JSX.Element {
  const [showUpload, setShowUpload] = useState(false);
  const [uploading,  setUploading]  = useState(false);
  const [playing,    setPlaying]    = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function handleUpload(
    file:       File,
    promptText: string,
    promptLang: string,
    setPrimary: boolean,
  ): Promise<void> {
    setUploading(true);
    try {
      await useCardStore.getState().uploadVoiceRef(cardId, file, {
        label: file.name,
        promptText,
        promptLang,
        setPrimary,
      });
      showToast('上传成功', { variant: 'success' });
      setShowUpload(false);
    } catch (err: unknown) {
      showToast(`上传失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(refId: string): Promise<void> {
    try {
      await useCardStore.getState().deleteVoiceRef(cardId, refId);
      showToast('已删除', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`删除失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }

  async function handleSetPrimary(refId: string): Promise<void> {
    try {
      await useCardStore.getState().setPrimaryVoiceRef(cardId, refId);
      showToast('已设为主用', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`设置失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }

  async function handlePlay(refId: string): Promise<void> {
    if (playing === refId) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    try {
      const blob = await cardsApi.downloadVoiceRef(cardId, refId);
      const url  = URL.createObjectURL(blob);
      if (audioRef.current) audioRef.current.pause();
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.play().catch(() => {});
      setPlaying(refId);
      audio.addEventListener('ended', () => setPlaying(null));
    } catch {
      showToast('试听失败', { variant: 'danger' });
    }
  }

  const primary = voiceProfile.refAudios.find((r) => r.id === voiceProfile.primaryId);

  return (
    <div className="max-w-lg pt-3">
      {/* Current primary */}
      <div className="mb-4">
        <span className="text-xs text-[var(--ema-text-tertiary)]">当前主用：</span>
        {primary ? (
          <span className="text-sm text-[var(--ema-success-text)] ml-1">{primary.label}</span>
        ) : (
          <span className="text-sm text-[var(--ema-text-tertiary)] ml-1">无</span>
        )}
      </div>

      {/* Audio list */}
      {voiceProfile.refAudios.length === 0 ? (
        <p className="text-[var(--ema-text-tertiary)] text-sm mb-4">
          尚无参考音频。上传后可用于 GPT-SoVITS 声音复刻。
        </p>
      ) : (
        <div className="flex flex-col gap-2 mb-4">
          {isBuiltin && (
            <p className="text-xs text-[var(--ema-text-tertiary)] mb-1">
              内置角色音色为只读，不可上传 / 删除 / 改主用。
            </p>
          )}
          {voiceProfile.refAudios.map((ref, i) => (
            <div key={ref.id} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
            <RefAudioRow
              key={ref.id}
              refAudio={ref}
              isPrimary={ref.id === voiceProfile.primaryId}
              isPlaying={playing === ref.id}
              onPlay={() => handlePlay(ref.id)}
              onSetPrimary={isBuiltin ? undefined : () => handleSetPrimary(ref.id)}
              onDelete={isBuiltin ? undefined : () => handleDelete(ref.id)}
            />
            </div>
          ))}
        </div>
      )}

      {/* Upload trigger / form — hidden for builtin (read-only) cards */}
      {!isBuiltin && (
        !showUpload ? (
          <Button
            variant="secondary"
            size="sm"
            icon="i-mdi:plus"
            onClick={() => setShowUpload(true)}
          >
            上传参考音频
          </Button>
        ) : (
          <UploadForm
            onUpload={handleUpload}
            uploading={uploading}
            onCancel={() => setShowUpload(false)}
          />
        )
      )}
    </div>
  );
}

// ── RefAudioRow ───────────────────────────────────────────────────────────────

function RefAudioRow({
  refAudio, isPrimary, isPlaying, onPlay, onSetPrimary, onDelete,
}: {
  refAudio:     CharacterRefAudio;
  isPrimary:    boolean;
  isPlaying:    boolean;
  onPlay():     void;
  onSetPrimary?(): void;
  onDelete?():   void;
}): JSX.Element {
  return (
    <EntityRow decorate="ema-card-decorate--mesh" className="p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={isPrimary ? 'size-2 rounded-full bg-[var(--ema-success)]' : 'size-2 rounded-full border border-[var(--ema-text-tertiary)]'} aria-hidden />
          <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{refAudio.label}</span>
        </div>
        <div className="flex gap-1.5">
          <Button
            variant={isPlaying ? 'primary' : 'ghost'}
            size="sm"
            icon={isPlaying ? 'i-mdi:stop' : 'i-mdi:play'}
            onClick={onPlay}
          >
            {isPlaying ? '停止' : '试听'}
          </Button>
          {!isPrimary && onSetPrimary && (
            <Button variant="secondary" size="sm" onClick={onSetPrimary}>
              设主用
            </Button>
          )}
          {onDelete && (
            <Button variant="danger" size="sm" onClick={onDelete}>
              删除
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-[var(--ema-text-tertiary)] mt-1">
        prompt: "{refAudio.promptText}" · lang: {refAudio.promptLang}
      </p>
    </EntityRow>
  );
}

// ── UploadForm ────────────────────────────────────────────────────────────────

function UploadForm({
  onUpload,
  uploading,
  onCancel,
}: {
  onUpload:  (file: File, promptText: string, promptLang: string, setPrimary: boolean) => void;
  uploading: boolean;
  onCancel:  () => void;
}): JSX.Element {
  const [file,       setFile]       = useState<File | null>(null);
  const [promptText, setPromptText] = useState('');
  const [promptLang, setPromptLang] = useState('zh');
  const [setPrimary, setSetPrimary] = useState(false);

  function handleSubmit(): void {
    if (!file || !promptText.trim()) return;
    onUpload(file, promptText.trim(), promptLang, setPrimary);
  }

  return (
    <div className="bg-[var(--ema-surface-1)] ema-glass-weak border border-[var(--ema-border)] rounded-xl p-4 ema-card-decorate ema-card-decorate--mesh">
      <h3 className="text-sm font-semibold text-[var(--ema-text-primary)] mb-3">上传参考音频</h3>
      <div className="flex flex-col gap-3">
        {/* File picker — no component equivalent */}
        <FilePicker
          accept=".wav,.mp3,.flac,.ogg,.m4a"
          onSelect={(files) => setFile(files[0] ?? null)}
          className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-[var(--ema-border)] bg-[var(--ema-surface-1)] text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)] transition-ema"
        >
          <span className="i-mdi:file-upload-outline text-sm" aria-hidden />
          {file ? file.name : '选择文件'}
        </FilePicker>

        <Textarea
          minRows={2}
          maxRows={4}
          placeholder="参考文本(如：'你好呀，今天过得怎么样？')"
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
        />

        <Select
          value={promptLang}
          onChange={setPromptLang}
          options={LANG_OPTIONS}
        />

        <Checkbox
          checked={setPrimary}
          onCheckedChange={(v) => setSetPrimary(v === true)}
          label="设为主用"
          showLabel
        />
      </div>

      <div className="flex gap-2 mt-4">
        <Button
          variant="primary"
          size="sm"
          loading={uploading}
          disabled={!file || !promptText.trim()}
          onClick={handleSubmit}
        >
          上传
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}
