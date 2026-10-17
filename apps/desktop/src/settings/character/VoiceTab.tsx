// 参考音频 Tab:行式列表(●主项/播放/展示名/时长/体积/⋯菜单);右上导入音频。
// 导入后只允许改展示名;promptText/promptLang/时长/体积都是导入事实,不重传。
import { useEffect, useState, type JSX } from 'react';
import {
  Tooltip,
  Button, Dialog, DropdownMenu, IconButton, Input, ScrollArea, Select, Textarea,
  type MenuItem,
} from '@ema-agent/ui';
import { ServerApiError } from '../../api/client.js';
import { charactersApi, type Character } from '../../api/characters.js';
import { useCharacterStore } from '../../stores/character.js';
import { tauriBridge } from '../../lib/tauri/tauriBridge.js';
import { showToast } from '../../lib/notifications/toast.js';
import { MainView, useMainNavigationStore } from '../../layout/navigation.js';

type VoiceSample = Character['voiceSamples'][number];

// 同一页的音频行共享播放器, 新试听先停旧试听.
let currentAudio: { audio: HTMLAudioElement; key: string } | null = null;
const playbackListeners = new Set<(key: string | null) => void>();

function notifyPlaying(key: string | null): void {
  for (const listener of playbackListeners) listener(key);
}

function stopCurrentPlayback(): void {
  const current = currentAudio;
  if (!current) return;
  currentAudio = null;
  current.audio.onended = null;
  current.audio.onerror = null;
  current.audio.pause();
  current.audio.removeAttribute('src');
  current.audio.load();
  notifyPlaying(null);
}

async function playVoice(characterName: string, voiceName: string): Promise<void> {
  stopCurrentPlayback();
  const audio = new Audio();
  const current = { audio, key: voiceName };
  currentAudio = current;
  notifyPlaying(voiceName);
  audio.onended = () => {
    if (currentAudio === current) stopCurrentPlayback();
  };
  audio.onerror = () => {
    if (currentAudio !== current) return;
    stopCurrentPlayback();
    showToast('播放失败: 音频读取或解码失败', { variant: 'danger' });
  };
  try {
    const url = await charactersApi.voiceFileUrl(characterName, voiceName);
    // 文件地址准备期间也可以停止或切换音频, 旧结果不能恢复已经结束的试听.
    if (currentAudio !== current) return;
    audio.src = url;
    await audio.play();
  } catch (error) {
    if (currentAudio !== current) return;
    stopCurrentPlayback();
    throw error;
  }
}

function usePlayingKey(): string | null {
  const [playingKey, setPlayingKey] = useState<string | null>(currentAudio?.key ?? null);
  useEffect(() => {
    playbackListeners.add(setPlayingKey);
    return () => { playbackListeners.delete(setPlayingKey); };
  }, []);
  return playingKey;
}

export function VoiceTab({ character }: { character: Character }): JSX.Element {
  const samples = character.voiceSamples;
  const [importOpen, setImportOpen] = useState(false);
  const store = useCharacterStore();

  useEffect(() => {
    const unsubscribe = useMainNavigationStore.subscribe((state, previous) => {
      if (previous.activeView === MainView.Settings && state.activeView !== MainView.Settings) {
        stopCurrentPlayback();
      }
    });
    return () => {
      unsubscribe();
      stopCurrentPlayback();
    };
  }, [character.name]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
        <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">参考音频</h3>
        <Button variant="primary" size="sm" icon="i-mdi:plus" onClick={() => setImportOpen(true)}>
          导入音频
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-5 pb-5">
          {samples.length === 0 && (
            <p className="py-10 text-center text-xs text-[var(--ema-text-tertiary)]">
              还没有参考音频,点右上角导入
            </p>
          )}
          {samples.map((sample, index) => (
            <VoiceRow key={sample.name} character={character} sample={sample} index={index} />
          ))}
          <p className="mt-2 text-[11px] text-[var(--ema-text-tertiary)]">
            导入后只允许修改展示名;promptText/promptLang/时长都是导入事实。不提供重新上传替代。
          </p>
        </div>
      </ScrollArea>
      <ImportVoiceDialog
        character={character}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </div>
  );
}

function VoiceRow({ character, sample, index }: {
  character: Character;
  sample: VoiceSample;
  index: number;
}): JSX.Element {
  const store = useCharacterStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sample.displayName);
  const playingKey = usePlayingKey();
  const isThisPlaying = playingKey === sample.name;

  useEffect(() => setDraft(sample.displayName), [sample.displayName]);

  async function handlePlayToggle(): Promise<void> {
    if (isThisPlaying) {
      stopCurrentPlayback();
      return;
    }
    try {
      await playVoice(character.name, sample.name);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '播放失败', { variant: 'danger' });
    }
  }

  async function saveDisplayName(): Promise<void> {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === sample.displayName) {
      setDraft(sample.displayName);
      return;
    }
    try {
      await store.patchVoice(character.name, sample.name, { displayName: next });
      showToast('已保存', { variant: 'success' });
    } catch (error) {
      setDraft(sample.displayName);
      showToast(error instanceof Error ? error.message : '保存失败', { variant: 'danger' });
    }
  }

  const menuItems: MenuItem[] = [
    {
      kind: 'item',
      label: sample.isPrimary ? '主要参考音频' : '设为主要参考音频',
      icon: 'i-solar:star-bold-duotone',
      disabled: sample.isPrimary,
      onSelect: () => {
        void store.setPrimaryVoice(character.name, sample.name)
          .catch((error) => {
            if (error instanceof ServerApiError && error.code === 'character_work_running') {
              showToast('Session 活跃期间不能切换主要参考音频', { variant: 'warning' });
              return;
            }
            showToast(error instanceof Error ? error.message : '设置失败', { variant: 'danger' });
          });
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: '打开文件夹',
      icon: 'i-solar:folder-open-bold-duotone',
      onSelect: () => {
        void charactersApi.voiceLocation(character.name, sample.name)
          .then(({ path }) => tauriBridge.revealInFolder(path))
          .catch(() => showToast('打开文件夹失败', { variant: 'danger' }));
      },
    },
    {
      kind: 'item',
      label: '导出',
      icon: 'i-solar:download-minimalistic-bold-duotone',
      onSelect: () => {
        void (async () => {
          const destination = await tauriBridge.openFileDialog({ directory: true });
          if (!destination) return;
          try {
            await charactersApi.exportVoice(character.name, sample.name, destination);
            showToast('已导出', { variant: 'success' });
          } catch (error) {
            showToast(error instanceof Error ? error.message : '导出失败', { variant: 'danger' });
          }
        })();
      },
    },
    {
      kind: 'item',
      label: '永久删除',
      icon: 'i-solar:trash-bin-trash-bold-duotone',
      onSelect: () => void handleDelete(),
    },
  ];

  const [confirmDelete, setConfirmDelete] = useState(false);

  /** 本页正在试听的文件不能同时删除。 */
  function handleDelete(): void {
    if (isThisPlaying) {
      showToast('这条正在试听中,停止后才能删除', { variant: 'warning' });
      return;
    }
    setConfirmDelete(true);
  }

  async function confirmAndDelete(): Promise<void> {
    setConfirmDelete(false);
    try {
      await store.deleteVoice(character.name, sample.name);
      showToast('已删除参考音频', { variant: 'success' });
    } catch (error) {
      if (error instanceof ServerApiError && error.code === 'character_work_running') {
        showToast('Session 活跃期间不能删除角色资源', { variant: 'warning' });
        return;
      }
      showToast(error instanceof Error ? error.message : '删除失败', { variant: 'danger' });
    }
  }

  return (
    <div
      className="ema-stagger-in ema-card-decorate ema-card-decorate--cross flex items-center gap-3 rounded-xl border border-[var(--ema-border)]
        bg-[var(--ema-surface-1)] px-3 py-2.5 transition-ema
        hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]"
      style={{ '--stagger-i': index } as React.CSSProperties}
    >
      <Tooltip content={sample.isPrimary ? '主要参考音频' : '非主要参考音频'}>
        <span
          className={`h-4 w-4 shrink-0 rounded-full border-2
            ${sample.isPrimary
              ? 'border-[var(--ema-success)] bg-[var(--ema-success)]'
              : 'border-[var(--ema-text-tertiary)] bg-transparent'}`}
        />
      </Tooltip>
      <span className="i-solar:music-note-bold-duotone text-lg text-[var(--ema-primary)]" aria-hidden />

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-[var(--ema-text-primary)]">{sample.name}</p>
        {editing ? (
          <Input
            inputSize="sm"
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={() => void saveDisplayName()}
            onKeyDown={e => {
              if (e.key === 'Enter') void saveDisplayName();
              if (e.key === 'Escape') { setDraft(sample.displayName); setEditing(false); }
            }}
          />
        ) : (
          <Tooltip content="点击编辑展示名">
            <button
              type="button"
              className="block truncate text-[11px] text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-secondary)]"
              onClick={() => setEditing(true)}
            >
              {sample.displayName}
            </button>
          </Tooltip>
        )}
        <p className="text-[10px] text-[var(--ema-text-tertiary)]">
          {formatDuration(sample.durationMs)}{sample.durationMs !== null ? ' · ' : ''}{formatBytes(sample.byteSize)}
        </p>
      </div>

      <Button
        variant={isThisPlaying ? 'danger' : 'ghost'}
        size="sm"
        onClick={() => void handlePlayToggle()}
      >
        {isThisPlaying ? '■ 停止' : '▶ 播放'}
      </Button>
      <DropdownMenu
        side="bottom"
        align="end"
        items={menuItems}
        trigger={(
          <IconButton icon="i-lucide:more-horizontal" label="更多操作" size="sm" />
        )}
      />
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`删除参考音频「${sample.displayName}」`}
        description={sample.isPrimary
          ? '这是当前的主要参考音频,删除后将自动选择下一条。'
          : '永久删除这条参考音频文件。'}
        widthClass="max-w-md"
      >
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>取消</Button>
          <Button variant="danger" onClick={() => void confirmAndDelete()}>永久删除</Button>
        </div>
      </Dialog>
    </div>
  );
}

// ── 导入(必填 promptText/promptLang,是注册/克隆的事实输入) ───────────────────

function ImportVoiceDialog({ character, open, onOpenChange }: {
  character: Character;
  open: boolean;
  onOpenChange(v: boolean): void;
}): JSX.Element {
  const store = useCharacterStore();
  const [sourceFile, setSourceFile] = useState('');
  const [promptText, setPromptText] = useState('');
  const [promptLang, setPromptLang] = useState('zh');
  const [saving, setSaving] = useState(false);

  async function handleImport(): Promise<void> {
    if (!sourceFile || !promptText.trim()) return;
    setSaving(true);
    try {
      await store.importVoice(character.name, {
        sourceFile,
        promptText: promptText.trim(),
        promptLang: promptLang.trim() || 'zh',
      });
      showToast('已导入参考音频', { variant: 'success' });
      setSourceFile(''); setPromptText('');
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ServerApiError && error.code === 'character_work_running') {
        showToast('当前角色有正在执行的任务,请先停止或等其结束后再导入', { variant: 'warning' });
        return;
      }
      showToast(error instanceof Error ? error.message : '导入失败', { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="导入参考音频"
      description="从本机选择音频文件;promptText/promptLang 是音色注册与克隆的事实输入,导入后不可改。"
      widthClass="max-w-md"
    >
      <div className="flex flex-col gap-3 pt-1">
        <label className="flex flex-col gap-1 text-xs text-[var(--ema-text-secondary)]">
          音频文件
          <div className="flex gap-2">
            <Input value={sourceFile} readOnly placeholder="选择 .wav/.mp3 文件" className="flex-1" />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void tauriBridge.openFileDialog({
                  filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg'] }],
                }).then(result => { if (result) setSourceFile(result); });
              }}
            >
              浏览
            </Button>
          </div>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ema-text-secondary)]">
          promptText(音频的朗读文本)
          <Textarea
            value={promptText}
            onChange={e => setPromptText(e.target.value)}
            placeholder="请一定要填写这段音频里说的话的原文 否则语音生成的结果极差"
            minRows={3}
            maxRows={10}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ema-text-secondary)]">
          promptLang(语言)
          <Select
            value={promptLang}
            options={[
              { value: 'zh', label: '中文(zh)' },
              { value: 'en', label: 'English(en)' },
              { value: 'ja', label: '日本語(ja)' },
            ]}
            onChange={setPromptLang}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!sourceFile || !promptText.trim()}
            onClick={() => void handleImport()}
          >
            导入
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '';
  return `${(durationMs / 1000).toFixed(1)}s`;
}
