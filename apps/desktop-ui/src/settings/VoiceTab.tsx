/**
 * VoiceTab — manage refAudios: upload, test listen, set primary, delete.
 */
import { useState, useRef, type ChangeEvent, type JSX } from 'react';
import { Button, Checkbox, Select, Textarea } from '@ema-agent/ui';
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
}: {
  cardId:       CharacterCardId;
  voiceProfile: CharacterVoiceProfile;
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
        <span className="text-xs text-neutral-400">当前主用：</span>
        {primary ? (
          <span className="text-sm text-green-300 ml-1">{primary.label}</span>
        ) : (
          <span className="text-sm text-neutral-500 ml-1">无</span>
        )}
      </div>

      {/* Audio list */}
      {voiceProfile.refAudios.length === 0 ? (
        <p className="text-neutral-500 text-sm mb-4">
          尚无参考音频。上传后可用于 GPT-SoVITS 声音复刻。
        </p>
      ) : (
        <div className="flex flex-col gap-2 mb-4">
          {voiceProfile.refAudios.map((ref) => (
            <RefAudioRow
              key={ref.id}
              refAudio={ref}
              isPrimary={ref.id === voiceProfile.primaryId}
              isPlaying={playing === ref.id}
              onPlay={() => handlePlay(ref.id)}
              onSetPrimary={() => handleSetPrimary(ref.id)}
              onDelete={() => handleDelete(ref.id)}
            />
          ))}
        </div>
      )}

      {/* Upload trigger / form */}
      {!showUpload ? (
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
  onSetPrimary(): void;
  onDelete():   void;
}): JSX.Element {
  return (
    <div className="bg-neutral-900/80 ema-glass-weak border border-neutral-800/40 rounded-xl p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={isPrimary ? 'text-green-400' : 'text-neutral-500'}>●</span>
          <span className="text-sm font-medium">{refAudio.label}</span>
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
          {!isPrimary && (
            <Button variant="secondary" size="sm" onClick={onSetPrimary}>
              设主用
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={onDelete}>
            删除
          </Button>
        </div>
      </div>
      <p className="text-xs text-neutral-500 mt-1">
        prompt: "{refAudio.promptText}" · lang: {refAudio.promptLang}
      </p>
    </div>
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

  function handleFileChange(e: ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  }

  function handleSubmit(): void {
    if (!file || !promptText.trim()) return;
    onUpload(file, promptText.trim(), promptLang, setPrimary);
  }

  return (
    <div className="bg-neutral-900/80 ema-glass-weak border border-neutral-800/40 rounded-2xl p-4">
      <h3 className="text-sm font-semibold mb-3">上传参考音频</h3>
      <div className="flex flex-col gap-3">
        {/* File picker — no component equivalent */}
        <input
          type="file"
          accept=".wav,.mp3,.flac,.ogg,.m4a"
          onChange={handleFileChange}
          className="text-sm text-neutral-300"
        />

        <Textarea
          minRows={2}
          maxRows={4}
          placeholder="参考文本（如：'你好呀，今天过得怎么样？'）"
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
