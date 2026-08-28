// 记忆正式文件：左侧文件树（可整体折叠）+ 右侧只读预览/整文件编辑。
// 整合占用（busyPaths）的文件锁定编辑；保存带 mtime 冲突校验，被改写时给出刷新选择。
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Button, Dialog, IconButton, Input, Select, Textarea } from '@ema-agent/ui';
import { Markdown } from '../../markdown/renderer.js';
import { useMemoryStore } from '../../stores/memory.js';
import { useCharacterStore } from '../../stores/character.js';
import { ServerApiError } from '../../api/client.js';
import type { MemoryFileContent } from '../../api/memory.js';
import { showToast } from '../../lib/toast.js';

export function MemoryFilesTab(): JSX.Element {
  const [treeOpen, setTreeOpen] = useState(true);
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<MemoryFileContent | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busyPaths, setBusyPaths] = useState<ReadonlySet<string>>(new Set());
  const [noteOpen, setNoteOpen] = useState(false);

  const loadTree = useCallback(async (): Promise<void> => {
    // 逐层展开目录：树规模小（正式记忆白名单内），一次性收全。
    const collected: string[] = [];
    const queue: (string | undefined)[] = [undefined];
    while (queue.length > 0) {
      const dir = queue.shift();
      const result = await useMemoryStore.getState().listFiles(dir ? { path: dir } : {});
      for (const entry of result.entries) {
        if (entry.entryType === 'directory') queue.push(entry.path);
        else collected.push(entry.path);
      }
    }
    collected.sort();
    setFiles(collected);
  }, []);

  const refreshBusyPaths = useCallback(async (): Promise<void> => {
    try {
      const { items } = await useMemoryStore.getState().listBusyPaths();
      setBusyPaths(new Set(items.map((item) => item.relativePath)));
    } catch {
      // 锁查询失败不阻塞浏览；保存时服务端 409 仍是底线。
    }
  }, []);

  useEffect(() => {
    void loadTree();
    void refreshBusyPaths();
    const timer = setInterval(() => void refreshBusyPaths(), 5_000);
    return () => clearInterval(timer);
  }, [loadTree, refreshBusyPaths]);

  const openFile = useCallback(async (path: string): Promise<void> => {
    if (editing && doc && draft !== doc.content) {
      if (!window.confirm('当前修改未保存，切换文件将丢失，继续吗？')) return;
    }
    setEditing(false);
    setConflict(false);
    setSelected(path);
    setDoc(null);
    try {
      const result = await useMemoryStore.getState().readFile({ path });
      setDoc(result);
      setDraft(result.content);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取文件失败', { variant: 'danger' });
      setSelected(null);
    }
  }, [doc, draft, editing]);

  const locked = selected !== null && busyPaths.has(selected);
  const dirty = editing && doc !== null && draft !== doc.content;

  async function save(): Promise<void> {
    if (!selected || !doc) return;
    setSaving(true);
    try {
      const result = await useMemoryStore.getState().saveFileContent({
        path: selected,
        content: draft,
        baseMtimeMs: doc.mtimeMs,
      });
      setDoc({ ...doc, content: draft, mtimeMs: result.mtimeMs, truncated: false });
      setEditing(false);
      setConflict(false);
      showToast('已保存', { variant: 'success' });
    } catch (error) {
      const code = error instanceof ServerApiError ? error.code : undefined;
      if (code === 'memory_file_changed') {
        setConflict(true);
      } else if (code === 'memory_file_locked') {
        showToast('记忆整合正在进行，此文件暂时不可编辑', { variant: 'warning' });
        void refreshBusyPaths();
      } else {
        showToast(error instanceof Error ? error.message : '保存失败', { variant: 'danger' });
      }
    } finally {
      setSaving(false);
    }
  }

  /** 进入编辑：预览只读了开头时先取全量（编辑保存是整文件覆盖，拿截断内容会丢尾部）。 */
  async function startEdit(): Promise<void> {
    if (!selected || !doc) return;
    if (doc.truncated) {
      try {
        const full = await useMemoryStore.getState().readFile({ path: selected, maxLines: 10_000 });
        if (full.truncated) {
          showToast('文件超过可编辑行数上限，请用外部编辑器修改', { variant: 'warning' });
          return;
        }
        setDoc(full);
        setDraft(full.content);
      } catch (error) {
        showToast(error instanceof Error ? error.message : '读取完整文件失败', { variant: 'danger' });
        return;
      }
    }
    setEditing(true);
  }

  async function discardAndReload(): Promise<void> {
    if (!selected) return;
    setConflict(false);
    const path = selected;
    setDoc(null);
    const result = await useMemoryStore.getState().readFile({ path });
    setDoc(result);
    setDraft(result.content);
  }

  const grouped = useMemo(() => groupByTrack(files), [files]);

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex items-center justify-between shrink-0">
        <p className="text-xs text-[var(--ema-text-tertiary)]">
          正式记忆文件可直接编辑；整合进行中涉及的文件会临时锁定。
        </p>
        <Button variant="secondary" size="sm" icon="i-lucide:plus" onClick={() => setNoteOpen(true)}>
          记一条
        </Button>
      </div>

      <div className="flex flex-1 min-h-0 gap-0 border rounded-xl overflow-hidden border-[var(--ema-border)]">
        {/* 左：文件树（整体折叠） */}
        <div className={`shrink-0 border-r border-[var(--ema-border)] bg-[var(--ema-surface-1)] transition-[width] ${treeOpen ? 'w-56' : 'w-0 border-r-0'} overflow-hidden`}>
          <div className="h-full overflow-y-auto py-2">
            {(['work', 'relationship'] as const).map((track) => (
              <div key={track} className="mb-2">
                <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ema-text-tertiary)]">
                  {track === 'work' ? '工作' : '关系'}
                </p>
                {grouped[track].map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => void openFile(file.path)}
                    className={`w-full flex items-center gap-1.5 px-3 py-1 text-left text-xs transition-colors ${
                      selected === file.path
                        ? 'bg-[var(--ema-surface-3)] text-[var(--ema-text-primary)]'
                        : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]'
                    }`}
                    style={{ paddingLeft: `${12 + file.depth * 12}px` }}
                  >
                    <span className="i-lucide:file-text shrink-0 opacity-60" aria-hidden />
                    <span className="truncate">{file.name}</span>
                    {busyPaths.has(file.path) && (
                      <span className="i-lucide:lock shrink-0 ml-auto text-[var(--ema-warning)]" aria-label="整合中" />
                    )}
                  </button>
                ))}
                {grouped[track].length === 0 && (
                  <p className="px-3 py-1 text-[11px] text-[var(--ema-text-tertiary)]">暂无文件</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 折叠/展开按钮（树与内容的分界上沿） */}
        <div className="relative shrink-0">
          <IconButton
            size="sm"
            icon={treeOpen ? 'i-lucide:panel-left-close' : 'i-lucide:panel-left-open'}
            label={treeOpen ? '折叠文件树' : '展开文件树'}
            className="absolute -left-3 top-2 z-10 size-6 rounded-full border bg-[var(--ema-surface-3)] border-[var(--ema-border)]"
            onClick={() => setTreeOpen((open) => !open)}
          />
        </div>

        {/* 右：预览 / 编辑 */}
        <div className="flex-1 min-w-0 flex flex-col">
          {selected === null ? (
            <div className="flex-1 flex items-center justify-center text-xs text-[var(--ema-text-tertiary)]">
              从左侧选择一份记忆文件
            </div>
          ) : doc === null ? (
            <div className="flex-1 flex items-center justify-center text-xs text-[var(--ema-text-tertiary)]">读取中…</div>
          ) : (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--ema-border)] shrink-0">
                <span className="text-xs font-mono truncate text-[var(--ema-text-secondary)]">{selected}</span>
                <span className="ml-auto flex items-center gap-1 shrink-0">
                  {editing ? (
                    <>
                      <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={() => void save()}>
                        保存
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setDraft(doc.content); setConflict(false); }}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="i-lucide:pencil"
                      disabled={locked}
                      onClick={() => void startEdit()}
                    >
                      编辑
                    </Button>
                  )}
                </span>
              </div>

              {locked && (
                <div className="px-3 py-2 text-xs border-b border-[var(--ema-warning)]/40 bg-[var(--ema-warning-muted)] text-[var(--ema-warning-text)] shrink-0">
                  记忆整合正在进行，此文件暂时只读。
                </div>
              )}
              {conflict && (
                <div className="px-3 py-2 text-xs border-b border-[var(--ema-danger)]/40 bg-[var(--ema-danger-muted)] text-[var(--ema-danger-text)] shrink-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>保存失败：文件刚被整合或外部改动。</span>
                    <Button variant="secondary" size="sm" onClick={() => void discardAndReload()}>放弃我的修改并刷新</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(draft);
                        showToast('已复制你的文本', { variant: 'success' });
                      }}
                    >
                      复制我的文本
                    </Button>
                  </div>
                </div>
              )}
              {doc.truncated && !editing && (
                <div className="px-3 py-1.5 text-[11px] text-[var(--ema-text-tertiary)] border-b border-[var(--ema-border)] shrink-0">
                  文件较大，只读取了开头部分；编辑会拿到完整内容。
                </div>
              )}

              <div className="flex-1 min-h-0 overflow-y-auto p-3">
                {editing ? (
                  <Textarea
                    containerless
                    autoGrow={false}
                    className="w-full h-full min-h-[320px] bg-transparent font-mono text-xs resize-none focus:outline-none text-[var(--ema-text-secondary)]"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                ) : (
                  <Markdown source={doc.content} />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {noteOpen && (
        <NoteDialog
          onClose={() => setNoteOpen(false)}
          onCreated={() => {
            setNoteOpen(false);
            showToast('已记下，会在下次整合时消化', { variant: 'success' });
          }}
        />
      )}
    </div>
  );
}

// ── 便签弹窗 ──────────────────────────────────────────────────────────────────

function NoteDialog({ onClose, onCreated }: { onClose(): void; onCreated(): void }): JSX.Element {
  const activeCharacter = useCharacterStore((s) =>
    s.characters.find((item) => item.id === s.activeCharacterId),
  );
  const [target, setTarget] = useState<'work' | 'relationshipShared' | 'relationshipCharacter'>('work');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const targetOptions = [
    { value: 'work', label: '工作记忆' },
    { value: 'relationshipShared', label: '关系记忆（共享）' },
    ...(activeCharacter
      ? [{ value: 'relationshipCharacter', label: `关系记忆（仅 ${activeCharacter.name}）` }]
      : []),
  ];

  async function submit(): Promise<void> {
    if (!title.trim() || !content.trim()) return;
    setSubmitting(true);
    try {
      await useMemoryStore.getState().createNote({
        target,
        title: title.trim(),
        content: content.trim(),
        ...(target === 'relationshipCharacter' && activeCharacter
          ? { characterDirectoryName: activeCharacter.directoryName }
          : {}),
      });
      onCreated();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存便签失败', { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title="记一条" hideClose>
      <div className="flex flex-col gap-3">
        <Select value={target} onChange={(value) => setTarget(value as typeof target)} options={targetOptions} />
        <Input
          placeholder="标题（如：偏好深色主题）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <Textarea
          minRows={3}
          maxRows={8}
          placeholder="要记住的内容…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={!title.trim() || !content.trim()}
            onClick={() => void submit()}
          >
            记下
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ── 树数据 ────────────────────────────────────────────────────────────────────

interface TreeFile {
  path: string;
  name: string;
  depth: number;
}

function groupByTrack(files: readonly string[]): { work: TreeFile[]; relationship: TreeFile[] } {
  const work: TreeFile[] = [];
  const relationship: TreeFile[] = [];
  for (const path of files) {
    const segments = path.split('/');
    const entry: TreeFile = {
      path,
      name: segments[segments.length - 1] ?? path,
      depth: Math.max(0, segments.length - 2),
    };
    if (path.startsWith('work/')) work.push(entry);
    else if (path.startsWith('relationship/')) relationship.push(entry);
  }
  return { work, relationship };
}
