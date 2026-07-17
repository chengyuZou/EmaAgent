/**
 * KnowledgeBaseTab — document ingest, list, delete, and search test.
 */
import { useState, useEffect, useCallback, type CSSProperties, type JSX } from 'react';
import { Button, IconButton, Input, Spinner, Badge, Callout, EmptyState, EntityRow, Select, Progress, Dialog } from '@ema-agent/ui';
import { useKbStore, type IngestJob, type IngestStage, type KbLibraryWire } from '../stores/kb-store.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { showToast } from '../lib/toast.js';
import { kbApi, type DocumentAssetWire, type ChunkSummaryWire, type AssetUsageWire } from '../api/knowledge-base.js';
import { settingsApi, type KbModelsConfig, type KbModelRef } from '../api/settings.js';
import { modelBindingsApi, type AvailableBindingModel } from '../api/model-bindings.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  indexed:  '已索引',
  indexing: '索引中',
  pending:  '等待中',
  error:    '错误',
};

const STATUS_VARIANT: Record<string, 'success' | 'warn' | 'neutral' | 'danger'> = {
  indexed:  'success',
  indexing: 'warn',
  pending:  'neutral',
  error:    'danger',
};

// ── DocumentRow ───────────────────────────────────────────────────────────────

function DocumentRow({ doc, currentEmbedModel, onDelete, index }: {
  doc: DocumentAssetWire; currentEmbedModel?: string; onDelete(): void; index?: number;
}): JSX.Element {
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Delayed unmount so the chunk viewer plays an exit animation on collapse.
  const [chunkMounted, setChunkMounted] = useState(false);
  useEffect(() => {
    if (expanded) { setChunkMounted(true); return; }
    const t = setTimeout(() => setChunkMounted(false), 200); // ≈ --ema-duration-base
    return () => clearTimeout(t);
  }, [expanded]);

  const [reembedding, setReembedding] = useState(false);

  // ebd 元信息：和当前 KB embed 模型不一致（或已标 stale）→ 需重嵌，标红
  const embedMismatch = !!doc.ebdModel && !!currentEmbedModel && doc.ebdModel !== currentEmbedModel;
  const embedStale    = !!doc.ebdStale || embedMismatch;
  // Per-doc "重嵌" applies when stale, or never embedded while a model is set.
  const needsReembed  = embedStale || (!doc.ebdModel && !!currentEmbedModel);

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    try {
      await useKbStore.getState().deleteDocument(doc.id);
      onDelete();
    } catch {
      showToast('删除失败', { variant: 'danger' });
    } finally {
      setDeleting(false);
    }
  }

  async function handleReembed(): Promise<void> {
    setReembedding(true);
    try {
      // 202 入队后立即返回; 重建在后台执行, 完成后文档列表由 SSE 驱动刷新。
      await kbApi.reembedDocument(doc.id);
      showToast('已加入后台重建', { variant: 'success' });
    } catch {
      showToast('重嵌失败（请先在上方选择嵌入模型）', { variant: 'danger' });
    } finally {
      setReembedding(false);
    }
  }

  return (
    <EntityRow
      decorate="ema-card-decorate--starfield"
      active={expanded}
      index={index}
      className={`flex flex-col ${expanded ? 'ema-row-active' : ''}`}
    >
      <div
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-ema"
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          className={`shrink-0 text-base text-[var(--ema-text-tertiary)] transition-ema
                      ${expanded ? 'i-solar:alt-arrow-down-linear' : 'i-solar:alt-arrow-right-linear'}`}
          aria-hidden
        />
        <span className="i-solar:document-bold text-[var(--ema-text-tertiary)] shrink-0 text-lg" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-[var(--ema-text-primary)] truncate" title={doc.filePath}>{doc.fileName}</p>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
            {doc.wordCount.toLocaleString()} 词{doc.pageCount ? ` · ${doc.pageCount} 页` : ''}
            {doc.ebdModel ? (
              <span className={`ml-2 font-mono ema-fade-in ${embedStale ? 'text-[var(--ema-danger)]' : 'text-[var(--ema-text-tertiary)]'}`}>
                {embedStale && <span className="i-mdi:alert-circle-outline mr-0.5 align-middle" aria-hidden />}{doc.ebdModel}{embedStale ? '（需重嵌）' : ''}
              </span>
            ) : currentEmbedModel ? (
              <span className="ml-2 ema-fade-in inline-flex items-center gap-0.5 text-[var(--ema-warning-text)]"><span className="i-mdi:alert-circle-outline" aria-hidden />未嵌入</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          <Badge variant="neutral" className="text-xs">
            {doc.useCount > 0 ? `被选 ${doc.useCount} 次` : '未使用'}
          </Badge>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'neutral'} className="text-xs">
            {STATUS_LABEL[doc.status] ?? doc.status}
          </Badge>
          {needsReembed && (
            <IconButton
              variant="default"
              size="sm"
              label="重新嵌入此文档"
              icon={reembedding ? 'i-solar:spinner-bold animate-spin' : 'i-solar:refresh-bold'}
              onClick={() => void handleReembed()}
              disabled={reembedding}
              className="ema-fade-in"
            />
          )}
          <IconButton
            variant="default"
            size="sm"
            label="删除"
            icon={deleting ? 'i-solar:spinner-bold animate-spin' : 'i-solar:trash-bin-2-bold'}
            onClick={() => void handleDelete()}
            disabled={deleting}
          />
        </div>
      </div>

      {chunkMounted && <ChunkViewer assetId={doc.id} closing={!expanded} />}
    </EntityRow>
  );
}

// ── ChunkViewer ───────────────────────────────────────────────────────────────
// Inline, cursor-paginated chunk list shown when a document row is expanded.

function ChunkViewer({ assetId, closing }: { assetId: string; closing?: boolean }): JSX.Element {
  const [items, setItems]           = useState<ChunkSummaryWire[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading]       = useState(false);
  const [loaded, setLoaded]         = useState(false);
  const [usage, setUsage]           = useState<AssetUsageWire | null>(null);

  const load = useCallback(async (cursor?: number): Promise<void> => {
    setLoading(true);
    try {
      const page = await kbApi.listChunks(assetId, { cursor, limit: 20 });
      setItems((prev) => (cursor === undefined ? page.items : [...prev, ...page.items]));
      setNextCursor(page.nextCursor);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [assetId]);

  useEffect(() => {
    void load(undefined);
    void kbApi.getUsage(assetId).then(setUsage).catch(() => { /* ignore */ });
  }, [load, assetId]);

  return (
    <div className={`${closing ? 'ema-fade-out' : 'ema-slide-down'} flex flex-col gap-1.5 px-3 py-2.5
                    border-t border-[var(--ema-border)] bg-[var(--ema-surface-0)]`}>
      {/* ── Usage: which sessions retrieved this doc, how many times ── */}
      {usage && (usage.totalCalls > 0 ? (
        <div className="ema-fade-in flex flex-col gap-1 pb-1.5 mb-0.5 border-b border-[var(--ema-border)]">
          <p className="text-[11px] text-[var(--ema-text-secondary)]">
            在 <b>{usage.sessions.length}</b> 个会话中被检索 <b>{usage.totalCalls}</b> 次
          </p>
          <div className="flex flex-wrap gap-1">
            {usage.sessions.slice(0, 8).map((s) => (
              <span key={s.sessionId}
                    className="ema-stagger-in text-[10px] px-1.5 py-0.5 rounded-full
                               bg-[var(--ema-surface-2)] text-[var(--ema-text-tertiary)]">
                {s.title || '(未命名)'} · {s.calls}
              </span>
            ))}
            {usage.sessions.length > 8 && (
              <span className="text-[10px] px-1 py-0.5 text-[var(--ema-text-tertiary)] opacity-60">
                +{usage.sessions.length - 8}
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="ema-fade-in text-[11px] text-[var(--ema-text-tertiary)] pb-1">尚未在任何会话中被检索</p>
      ))}

      {!loaded && loading ? (
        <div className="flex justify-center py-3 ema-fade-in"><Spinner size="sm" /></div>
      ) : items.length === 0 ? (
        <p className="text-xs py-3 text-center text-[var(--ema-text-tertiary)] ema-fade-in">该文档没有分块</p>
      ) : (
        items.map((ch, i) => (
          <div
            key={ch.id}
            className="ema-stagger-in rounded-lg bg-[var(--ema-surface-1)] px-2.5 py-2 ema-card-decorate ema-card-decorate--starfield"
            style={{ '--stagger-i': i % 20 } as CSSProperties}
          >
            <div className="flex items-center gap-2 mb-1 text-[10px] text-[var(--ema-text-tertiary)]">
              <span className="font-mono shrink-0">#{i + 1}</span>
              {ch.page !== undefined && <span className="shrink-0">第 {ch.page} 页</span>}
              <span className="shrink-0">{ch.tokenCount} tok</span>
              <span className={`shrink-0 inline-flex items-center gap-0.5 ${ch.hasEmbedding ? 'text-[var(--ema-success-text)]' : 'text-[var(--ema-text-tertiary)]'}`}>
                <span className={ch.hasEmbedding ? 'i-mdi:check-circle-outline' : 'i-mdi:circle-outline'} aria-hidden />
                {ch.hasEmbedding ? '已嵌入' : '仅 FTS'}
              </span>
              {ch.sectionPath.length > 0 && (
                <span className="truncate opacity-70" title={ch.sectionPath.join(' / ')}>
                  {ch.sectionPath.join(' / ')}
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--ema-text-secondary)] leading-relaxed line-clamp-3">{ch.text}</p>
          </div>
        ))
      )}

      {nextCursor !== null && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full ema-fade-in"
          disabled={loading}
          onClick={() => void load(nextCursor)}
        >
          {loading ? <Spinner size="sm" /> : '加载更多 chunk'}
        </Button>
      )}
    </div>
  );
}

// ── IngestForm ────────────────────────────────────────────────────────────────

function IngestForm({ onDone }: { onDone(): void }): JSX.Element {
  const ingesting   = useKbStore((s) => s.ingesting);
  const ingestError = useKbStore((s) => s.ingestError);
  const [filePath, setFilePath] = useState('');

  async function pickFile(): Promise<void> {
    const path = await tauriBridge.openFileDialog({
      filters: [
        { name: '文档', extensions: ['pdf', 'md', 'txt', 'docx', 'html', 'htm'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (path) setFilePath(path);
  }

  async function handleIngest(): Promise<void> {
    if (!filePath.trim()) {
      showToast('请选择或输入文件路径', { variant: 'warning' });
      return;
    }
    await useKbStore.getState().ingest(filePath.trim());
    if (!useKbStore.getState().ingestError) {
      setFilePath('');
      onDone();
      showToast('已加入处理队列', { variant: 'success' });
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl
                    bg-[var(--ema-surface-1)] border border-[var(--ema-border)] ema-card-decorate ema-card-decorate--starfield">
      <p className="text-sm font-semibold text-[var(--ema-text-primary)]">导入文档</p>

      <div className="flex gap-2">
        <Input
          className="flex-1 font-mono text-xs"
          placeholder="文件绝对路径，例如 D:\docs\paper.pdf"
          value={filePath}
          onChange={(e) => setFilePath(e.target.value)}
        />
        <Button variant="secondary" size="sm" onClick={() => void pickFile()}>
          浏览…
        </Button>
      </div>

      {ingestError && (
        <Callout variant="danger" className="text-xs">{ingestError}</Callout>
      )}

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          disabled={ingesting || !filePath.trim()}
          onClick={() => void handleIngest()}
        >
          {ingesting ? <><Spinner size="sm" className="mr-1.5" />导入中…</> : '开始导入'}
        </Button>
      </div>
    </div>
  );
}

// ── SearchTest ────────────────────────────────────────────────────────────────

function SearchTest(): JSX.Element {
  const searchResult  = useKbStore((s) => s.searchResult);
  const searchLoading = useKbStore((s) => s.searchLoading);
  const searchError   = useKbStore((s) => s.searchError);
  const [query, setQuery] = useState('');

  async function handleSearch(): Promise<void> {
    if (!query.trim()) return;
    await useKbStore.getState().search(query);
  }

  function handleChange(value: string): void {
    setQuery(value);
    // Clearing the box clears stale results so nothing lingers.
    if (!value.trim() && (searchResult || searchError)) {
      useKbStore.getState().clearSearch();
    }
  }

  function handleClear(): void {
    setQuery('');
    useKbStore.getState().clearSearch();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            className="text-sm pr-8"
            placeholder="输入查询语句测试检索…"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
          />
          {query && (
            <IconButton
              variant="default"
              size="sm"
              label="清空"
              icon="i-solar:close-circle-bold"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={handleClear}
            />
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={searchLoading || !query.trim()}
          onClick={() => void handleSearch()}
        >
          {searchLoading ? <Spinner size="sm" /> : '检索'}
        </Button>
      </div>

      {searchError && (
        <Callout variant="danger" className="text-xs">{searchError}</Callout>
      )}

      {searchResult && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-[var(--ema-text-tertiary)]">
            "{searchResult.query}" — {searchResult.hits.length} 条结果
          </p>
          {searchResult.hits.length === 0 ? (
            <p className="text-sm text-[var(--ema-text-tertiary)] py-3 text-center">未找到相关内容</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {searchResult.hits.map((hit, i) => (
                <div
                  key={hit.chunkId}
                  className="p-3 rounded-xl bg-[var(--ema-surface-1)] border border-[var(--ema-border)] ema-stagger-in ema-card-decorate ema-card-decorate--starfield"
                  style={{ '--stagger-i': i } as CSSProperties}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs text-[var(--ema-text-tertiary)] font-mono truncate">{hit.source.fileName}</span>
                    {hit.source.page && (
                      <span className="text-xs text-[var(--ema-text-tertiary)] shrink-0">第 {hit.source.page} 页</span>
                    )}
                    <span className="ml-auto text-xs text-[var(--ema-primary)] font-mono shrink-0">
                      {(hit.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="text-xs text-[var(--ema-text-secondary)] leading-relaxed line-clamp-4">
                    {hit.text}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ProcessingQueue ───────────────────────────────────────────────────────────
// Background ingest jobs, fed by the system SSE (kb_ingest_* → kb-store).

const STAGE_LABEL: Record<IngestStage, string> = {
  validate: '校验', parse: '解析', chunk: '分块', embed: '嵌入',
};
// Bar colour per stage — literal class strings so UnoCSS scans them statically.
const STAGE_BAR: Record<IngestStage, string> = {
  validate: 'bg-[var(--ema-info)]',
  parse:    'bg-[var(--ema-info)]',
  chunk:    'bg-[var(--ema-violet)]',
  embed:    'bg-[var(--ema-warning)]',
};

function ProcessingQueue(): JSX.Element | null {
  const jobs = useKbStore((s) => s.ingestJobs);
  const libs = useKbStore((s) => s.libs);

  useEffect(() => {
    void useKbStore.getState().loadIngestTasks();  // hydrate from the persistent queue
    void useKbStore.getState().loadLibs();
  }, []);

  const list = Object.values(jobs);
  if (list.length === 0) return null;

  // Group by kbId; preserve order of first appearance.
  const groups = new Map<string, typeof list>();
  for (const job of list) {
    const g = groups.get(job.kbId) ?? [];
    g.push(job);
    groups.set(job.kbId, g);
  }

  const libName = (kbId: string): string => libs.find((l) => l.id === kbId)?.name ?? kbId;

  return (
    <section className="flex flex-col gap-3 ema-fade-in">
      <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">处理队列</h2>
      {[...groups.entries()].map(([kbId, kbJobs], gi) => {
        const done  = kbJobs.filter((j) => j.status === 'done').length;
        const total = kbJobs.length;
        return (
          <div key={kbId} className="flex flex-col gap-1.5 ema-stagger-in"
               style={{ '--stagger-i': gi } as CSSProperties}>
            {/* Per-KB header with completion fraction */}
            <div className="flex items-center gap-2 px-1">
              <span className="i-solar:database-linear text-sm shrink-0 text-[var(--ema-text-tertiary)]" aria-hidden />
              <p className="text-xs font-medium text-[var(--ema-text-secondary)] truncate flex-1">
                {libName(kbId)}
              </p>
              <span className="text-[11px] font-mono shrink-0 text-[var(--ema-text-tertiary)]">
                {done}/{total}
              </span>
            </div>
            {kbJobs.map((job, i) => (
              <div key={job.assetId} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
                <IngestJobRow job={job} />
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

function IngestJobRow({ job }: { job: IngestJob }): JSX.Element {
  const failed  = job.status === 'failed' || job.status === 'partial_failed';
  const done    = job.status === 'done';
  const pending = job.status === 'pending';
  const pct     = Math.round(job.progress * 100);
  const barClass = failed ? 'bg-[var(--ema-danger)]'
    : done ? 'bg-[var(--ema-success)]'
    : job.stage ? STAGE_BAR[job.stage] : 'bg-[var(--ema-info)]';

  const label = job.status === 'partial_failed'
    ? '部分处理失败'
    : failed ? '处理失败' : done ? '已完成' : pending ? '排队中' : '正在处理';
  const status = failed ? '错误' : done ? '100%' : pending ? '等待'
    : `${job.stage ? STAGE_LABEL[job.stage] : ''} · ${pct}%`;

  return (
    <EntityRow decorate="ema-card-decorate--starfield" className={`px-3 py-2.5 flex flex-col gap-1.5 ${done ? 'ema-fade-out' : ''}`}>
      <div className="flex items-center gap-2">
        {failed ? (
          <span className="i-mdi:alert-circle text-base shrink-0 text-[var(--ema-danger)]" aria-hidden />
        ) : done ? (
          <span className="i-mdi:check-circle text-base shrink-0 text-[var(--ema-success)]" aria-hidden />
        ) : (
          <Spinner size="sm" />
        )}
        <span className="text-sm truncate flex-1 text-[var(--ema-text-primary)]" title={job.fileName}>
          {label} · {job.fileName}
        </span>
        <span className={`text-xs shrink-0 font-mono ${failed ? 'text-[var(--ema-danger)]' : 'text-[var(--ema-text-tertiary)]'}`}>
          {status}
        </span>
        {failed && (
          <Button size="sm" variant="ghost" className="shrink-0 ema-fade-in"
                  onClick={() => void useKbStore.getState().retryIngest(job.assetId)}>
            重试
          </Button>
        )}
      </div>

      <Progress progress={failed ? 100 : pct} barClass={barClass} height="h-1.5" animated={!failed && !done} />

      {failed && job.error && (
        <p className="text-[11px] text-[var(--ema-danger)] truncate ema-fade-in" title={job.error}>{job.error}</p>
      )}
    </EntityRow>
  );
}

// ── LibraryManager ────────────────────────────────────────────────────────────
// Registry of named KB libraries — create, activate, rename, unregister.

function LibraryRow({ lib, onActivate, onRename, onDelete }: {
  lib:        KbLibraryWire;
  onActivate(): void;
  onRename(name: string): void;
  onDelete(): void;
}): JSX.Element {
  const [editing,   setEditing]   = useState(false);
  const [nameInput, setNameInput] = useState(lib.name);
  const [deleting,  setDeleting]  = useState(false);

  async function commitRename(): Promise<void> {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === lib.name) { setEditing(false); setNameInput(lib.name); return; }
    onRename(trimmed);
    setEditing(false);
  }

  async function handleDelete(): Promise<void> {
    if (lib.isActive) { showToast('无法删除当前激活的知识库', { variant: 'warning' }); return; }
    setDeleting(true);
    onDelete();
  }

  return (
    <EntityRow
      decorate="ema-card-decorate--starfield"
      active={lib.isActive}
      className="group ema-slide-up flex items-center gap-3 px-3 py-2.5"
    >
      <span
        className={`shrink-0 text-lg ${lib.isActive ? 'i-solar:database-bold text-[var(--ema-primary)]' : 'i-solar:database-linear text-[var(--ema-text-tertiary)]'}`}
        aria-hidden
      />

      <div className="flex-1 min-w-0">
        {editing ? (
          <Input
            className="text-sm h-7"
            value={nameInput}
            autoFocus
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              if (e.key === 'Escape') { setEditing(false); setNameInput(lib.name); }
            }}
          />
        ) : (
          <>
            <p className="text-sm text-[var(--ema-text-primary)] truncate">{lib.name}</p>
            <p className="text-[10px] text-[var(--ema-text-tertiary)] font-mono truncate mt-0.5">{lib.path}</p>
          </>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0 transition-opacity duration-150
                      ${lib.isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}">
        {lib.isActive ? (
          <Badge variant="success" className="text-xs">激活中</Badge>
        ) : (
          <Button variant="ghost" size="sm" className="text-xs" onClick={onActivate}>
            激活
          </Button>
        )}
        <IconButton
          variant="default" size="sm" label="重命名"
          icon="i-solar:pen-bold"
          onClick={() => { setEditing(true); setNameInput(lib.name); }}
        />
        <IconButton
          variant="default" size="sm" label="移除"
          icon={deleting ? 'i-solar:spinner-bold animate-spin' : 'i-solar:trash-bin-2-bold'}
          disabled={deleting || lib.isActive}
          onClick={() => void handleDelete()}
        />
      </div>
    </EntityRow>
  );
}

function CreateLibDialog({ onCreated }: { onCreated(): void }): JSX.Element {
  const [open,    setOpen]    = useState(false);
  const [name,    setName]    = useState('');
  const [kbPath,  setKbPath]  = useState('');
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  function handleOpenChange(v: boolean): void {
    setOpen(v);
    if (!v) { setName(''); setKbPath(''); setError(null); }
  }

  async function pickFolder(): Promise<void> {
    const picked = await tauriBridge.openFileDialog({ directory: true });
    if (picked) setKbPath(picked);
  }

  async function handleCreate(): Promise<void> {
    const n = name.trim();
    const p = kbPath.trim();
    if (!n) { setError('请输入知识库名称'); return; }
    if (!p) { setError('请选择文件夹'); return; }
    setSaving(true); setError(null);
    const lib = await useKbStore.getState().createLib(n, p);
    setSaving(false);
    if (!lib) {
      setError(useKbStore.getState().libsError ?? '创建失败');
      return;
    }
    showToast(`已创建「${lib.name}」`, { variant: 'success' });
    handleOpenChange(false);
    onCreated();
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <span className="i-solar:add-circle-bold mr-1" aria-hidden />新建知识库
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange} title="新建知识库">
        <div className="flex flex-col gap-4 ema-slide-up">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--ema-text-tertiary)]">名称</label>
            <Input
              placeholder="我的知识库"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--ema-text-tertiary)]">存储文件夹</label>
            <div className="flex gap-2">
              <Input
                className="flex-1 font-mono text-xs"
                placeholder="选择一个空文件夹…"
                value={kbPath}
                onChange={(e) => setKbPath(e.target.value)}
              />
              <Button variant="secondary" size="sm" onClick={() => void pickFolder()}>浏览…</Button>
            </div>
            <p className="text-[11px] text-[var(--ema-text-tertiary)]">
              知识库的 SQLite 文件和向量文件将存储在此文件夹内，推荐选择一个新的空文件夹。
            </p>
          </div>

          {error && (
            <Callout variant="danger" className="text-xs ema-fade-in">{error}</Callout>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>取消</Button>
            <Button
              variant="primary" size="sm"
              disabled={saving || !name.trim() || !kbPath.trim()}
              onClick={() => void handleCreate()}
            >
              {saving ? <><Spinner size="sm" className="mr-1.5" />创建中…</> : '创建'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function LibraryManager(): JSX.Element {
  const libs       = useKbStore((s) => s.libs);
  const loading    = useKbStore((s) => s.libsLoading);
  const error      = useKbStore((s) => s.libsError);

  useEffect(() => { void useKbStore.getState().loadLibs(); }, []);

  return (
    <section className="flex flex-col gap-3 ema-fade-in">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">
          知识库
          {libs.length > 0 && (
            <span className="ml-2 text-xs text-[var(--ema-text-tertiary)]">({libs.length})</span>
          )}
        </h2>
        <CreateLibDialog onCreated={() => void useKbStore.getState().loadLibs()} />
      </div>

      {error && <Callout variant="danger" className="text-xs ema-fade-in">{error}</Callout>}

      {loading && libs.length === 0 ? (
        <div className="flex justify-center py-4"><Spinner size="sm" /></div>
      ) : libs.length === 0 ? (
        <EmptyState icon="i-solar:database-bold" title="暂无知识库，点击「新建知识库」开始" animate size="sm" className="h-20" />
      ) : (
        <div className="flex flex-col gap-2">
          {libs.map((lib, i) => (
            <div key={lib.id} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
              <LibraryRow
                lib={lib}
                onActivate={() => void useKbStore.getState().activateLib(lib.id).then(() => showToast(`已切换到「${lib.name}」`, { variant: 'success' }))}
                onRename={(name) => void useKbStore.getState().renameLib(lib.id, name).then(() => showToast('已重命名', { variant: 'success' }))}
                onDelete={() => void useKbStore.getState().deleteLib(lib.id).then(() => showToast('已移除', { variant: 'success' }))}
              />
            </div>
          ))}
        </div>
      )}

      <Callout variant="info" className="text-xs leading-relaxed ema-slide-up">
        移除知识库只是从列表取消注册，<b>不会删除磁盘文件</b>。需要彻底清除请手动删除对应文件夹。
      </Callout>
    </section>
  );
}

// ── KbModelSettings ───────────────────────────────────────────────────────────
// KB's own embed + rerank model choice (settings → kb.models), decoupled from
// LightRAG's lightrag-embed binding. Changing embed makes existing docs stale.

const NONE = '__none__';

function KbModelSettings({ onEmbedModelChanged }: { onEmbedModelChanged?: (model: string | undefined) => void }): JSX.Element {
  const [embedModels,  setEmbedModels]  = useState<AvailableBindingModel[]>([]);
  const [rerankModels, setRerankModels] = useState<AvailableBindingModel[]>([]);
  const [config, setConfig] = useState<KbModelsConfig>({});
  const [rebuilding, setRebuilding] = useState(false);
  // 后台重建任务句柄: kb_reembed_* SSE 终态到达后由下方 useEffect 收口。
  const [rebuildTaskId, setRebuildTaskId] = useState<string | null>(null);
  const rebuildTask = useKbStore((s) =>
    rebuildTaskId ? Object.values(s.reembedTasks).find((t) => t.taskId === rebuildTaskId) : undefined,
  );

  useEffect(() => {
    if (!rebuildTask) return;
    if (rebuildTask.status === 'done') {
      setRebuilding(false);
      setRebuildTaskId(null);
      showToast(`重建完成：${rebuildTask.completedItems ?? 0} 个文档`, { variant: 'success' });
    } else if (rebuildTask.status === 'partial_failed') {
      setRebuilding(false);
      setRebuildTaskId(null);
      showToast(`部分重建失败：${rebuildTask.completedItems ?? 0} 成功，${rebuildTask.failedItems ?? 0} 失败`, { variant: 'warning' });
    } else if (rebuildTask.status === 'failed') {
      setRebuilding(false);
      setRebuildTaskId(null);
      showToast(rebuildTask.error === '已取消' ? '已取消重建' : `重建失败：${rebuildTask.error ?? ''}`, { variant: 'danger' });
    }
  }, [rebuildTask]);

  useEffect(() => {
    void (async () => {
      const [emb, rer, cfg] = await Promise.all([
        modelBindingsApi.listAvailable('embed').catch(() => []),
        modelBindingsApi.listAvailable('rerank').catch(() => []),
        settingsApi.getKbModels().catch(() => ({} as KbModelsConfig)),
      ]);
      setEmbedModels(emb); setRerankModels(rer); setConfig(cfg);
    })();
  }, []);

  const enc = (r?: KbModelRef | null): string => (r ? `${r.providerConfigId}|${r.model}` : NONE);
  const dec = (v: string): KbModelRef | null => {
    if (v === NONE) return null;
    const i = v.indexOf('|');
    return i < 0 ? null : { providerConfigId: v.slice(0, i), model: v.slice(i + 1) };
  };

  async function save(next: KbModelsConfig): Promise<void> {
    const prevEmbed = config.embed;
    setConfig(next);
    try {
      await settingsApi.putKbModels(next);
      // embed 模型变了 -> 自动 invalidate(标 stale),让不匹配 doc 立刻显 ⚠️ + 重嵌按钮。
      // 之前要手动点"重建索引"才标 stale,导致切换后按钮时有时无。
      if (enc(next.embed) !== enc(prevEmbed)) {
        if (next.embed) {
          try { await kbApi.invalidate(next.embed.providerConfigId, next.embed.model); } catch { /* 标 stale 失败不阻断保存 */ }
        }
        onEmbedModelChanged?.(next.embed?.model);
      }
      showToast('已保存', { variant: 'success' });
    }
    catch { showToast('保存失败', { variant: 'danger' }); }
  }

  const opts = (models: AvailableBindingModel[], withNone: boolean) => [
    ...(withNone ? [{ value: NONE, label: '（不使用）' }] : []),
    ...models.map((m) => ({ value: `${m.providerConfigId}|${m.model}`, label: `${m.providerName} / ${m.model}` })),
  ];

  // 提交后台重建任务(202 + taskId); 进度与结果由 kb_reembed_* SSE 驱动,
  // 见上方 useEffect。先 invalidate 标 stale 再入队, 与旧同步流程语义一致。
  async function rebuildIndex(): Promise<void> {
    if (!config.embed) { showToast('请先选择嵌入模型', { variant: 'warning' }); return; }
    setRebuilding(true);
    try {
      await kbApi.invalidate(config.embed.providerConfigId, config.embed.model);
      const task = await kbApi.reembed({ ebdProviderId: config.embed.providerConfigId, ebdModel: config.embed.model });
      setRebuildTaskId(task.taskId);
    } catch {
      setRebuilding(false);
      showToast('重建任务提交失败', { variant: 'danger' });
    }
  }

  return (
    <section className="flex flex-col gap-3 ema-fade-in">
      <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">检索模型</h2>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5 ema-stagger-in" style={{ '--stagger-i': 0 } as CSSProperties}>
          <label className="text-xs text-[var(--ema-text-tertiary)]">嵌入模型（Embedding）</label>
          <Select
            value={enc(config.embed)}
            onChange={(v) => void save({ ...config, embed: dec(v) })}
            options={opts(embedModels, true)}
            placeholder="未设置 → 仅关键词检索"
          />
        </div>
        <div className="flex flex-col gap-1.5 ema-stagger-in" style={{ '--stagger-i': 1 } as CSSProperties}>
          <label className="text-xs text-[var(--ema-text-tertiary)]">重排模型（Rerank，可选）</label>
          <Select
            value={enc(config.rerank)}
            onChange={(v) => void save({ ...config, rerank: dec(v) })}
            options={opts(rerankModels, true)}
            placeholder="（不使用）"
          />
        </div>
      </div>

      <Callout variant="warn" className="text-xs leading-relaxed ema-slide-up">
        换<b>嵌入模型</b>会让已索引文档的向量与新查询<b>错配、检索骤减</b>——换完点下方<b>重建过期索引</b>。
        重排模型可随时更换，无需重建。此处与「叙事模式」的 LightRAG 嵌入互不影响。
      </Callout>

      <div className="flex items-center justify-between gap-2 ema-fade-in">
        <p className="text-[11px] text-[var(--ema-text-tertiary)]">
          把所有「未嵌入 / 过期」的文档用当前嵌入模型重新建立向量索引。
        </p>
        {rebuilding ? (
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="secondary" size="sm" disabled>
              <Spinner size="sm" className="mr-1.5" />重建中…
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (!rebuildTaskId) return;
                void kbApi.cancelReembed(rebuildTaskId)
                  .catch(() => showToast('取消失败', { variant: 'danger' }));
              }}
            >
              取消
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={!config.embed}
            onClick={() => void rebuildIndex()}
          >
            重建过期索引
          </Button>
        )}
      </div>
    </section>
  );
}

// ── KnowledgeBaseTab ──────────────────────────────────────────────────────────

export function KnowledgeBaseTab(): JSX.Element {
  const documents = useKbStore((s) => s.documents);
  const loading   = useKbStore((s) => s.loading);
  const error     = useKbStore((s) => s.error);
  const [showIngest,       setShowIngest]       = useState(false);
  const [ingestFormMounted, setIngestFormMounted] = useState(false);
  const [embedModel, setEmbedModel] = useState<string | undefined>();

  // Delayed unmount so IngestForm exit animation plays.
  useEffect(() => {
    if (showIngest) { setIngestFormMounted(true); return; }
    const t = setTimeout(() => setIngestFormMounted(false), 220);
    return () => clearTimeout(t);
  }, [showIngest]);

  useEffect(() => {
    void useKbStore.getState().loadDocuments();
    void settingsApi.getKbModels().then((m) => setEmbedModel(m.embed?.model)).catch(() => { /* ignore */ });
  }, []);

  return (
    <div className="flex flex-col gap-6">

      {/* ── KB library registry ── */}
      <LibraryManager />

      {/* ── Retrieval models (embed + rerank) ── */}
      <KbModelSettings onEmbedModelChanged={(m) => { setEmbedModel(m); void useKbStore.getState().loadDocuments(); }} />

      {/* ── Background processing queue ── */}
      <ProcessingQueue />

      {/* ── Document list ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">
            已导入文档
            {documents.length > 0 && (
              <span className="ml-2 text-xs text-[var(--ema-text-tertiary)]">({documents.length})</span>
            )}
            {documents.length > 0 && embedModel && (() => {
              const need = documents.filter((d) => d.ebdStale || (!!d.ebdModel && d.ebdModel !== embedModel) || (!d.ebdModel)).length;
              return need > 0 ? (
                <span className="ml-2 text-xs font-mono text-[var(--ema-danger)]">
                  · {need}/{documents.length} 需重嵌
                </span>
              ) : null;
            })()}
          </h2>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowIngest((v) => !v)}
          >
            <span className="i-solar:add-circle-bold mr-1" aria-hidden />
            {showIngest ? '收起' : '导入文档'}
          </Button>
        </div>

        {ingestFormMounted && (
          <div className={showIngest ? 'ema-slide-down' : 'ema-fade-out'}>
            <IngestForm onDone={() => setShowIngest(false)} />
          </div>
        )}

        {error && (
          <Callout variant="danger" className="text-xs ema-fade-in">{error}</Callout>
        )}

        {loading ? (
          <div className="flex h-24 items-center justify-center ema-fade-in">
            <Spinner size="md" />
          </div>
        ) : documents.length === 0 ? (
          <EmptyState icon="i-solar:database-bold" title="暂无文档，点击「导入文档」添加" animate size="sm" className="h-28" />
        ) : (
          <div className="ema-fade-in flex flex-col gap-1.5 pr-2">
            {documents.map((doc, i) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                index={i}
                currentEmbedModel={embedModel}
                onDelete={() => void useKbStore.getState().loadDocuments()}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Search test ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">检索测试</h2>
        <SearchTest />
      </section>
    </div>
  );
}
