/**
 * KnowledgeBaseTab — document ingest, list, delete, and search test.
 */
import { useState, useEffect, useCallback, type CSSProperties, type JSX } from 'react';
import { Button, IconButton, Input, Spinner, Badge, Callout, ScrollArea, Select } from '@ema-agent/ui';
import { useKbStore } from '../stores/kb-store.js';
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

function DocumentRow({ doc, currentEmbedModel, onDelete }: {
  doc: DocumentAssetWire; currentEmbedModel?: string; onDelete(): void;
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

  // ebd 元信息：和当前 KB embed 模型不一致（或已标 stale）→ 需重嵌，标红
  const embedMismatch = !!doc.ebdModel && !!currentEmbedModel && doc.ebdModel !== currentEmbedModel;
  const embedStale    = !!doc.ebdStale || embedMismatch;

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

  return (
    <div className="flex flex-col rounded-xl bg-[var(--ema-surface-1)] overflow-hidden">
      <div
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer
                   hover:bg-[var(--ema-surface-2)] transition-ema"
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
              <span className="ml-2 font-mono ema-fade-in" style={{ color: embedStale ? 'var(--ema-danger)' : 'var(--ema-text-tertiary)' }}>
                {embedStale && '⚠️ '}{doc.ebdModel}{embedStale ? '（需重嵌）' : ''}
              </span>
            ) : currentEmbedModel ? (
              <span className="ml-2 ema-fade-in" style={{ color: 'var(--ema-warning-text)' }}>⚠️ 未嵌入</span>
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
    </div>
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
            className="ema-stagger-in rounded-lg bg-[var(--ema-surface-1)] px-2.5 py-2"
            style={{ '--stagger-i': i % 20 } as CSSProperties}
          >
            <div className="flex items-center gap-2 mb-1 text-[10px] text-[var(--ema-text-tertiary)]">
              <span className="font-mono shrink-0">#{i + 1}</span>
              {ch.page !== undefined && <span className="shrink-0">第 {ch.page} 页</span>}
              <span className="shrink-0">{ch.tokenCount} tok</span>
              <span className="shrink-0" style={{ color: ch.hasEmbedding ? 'var(--ema-success-text)' : 'var(--ema-text-tertiary)' }}>
                {ch.hasEmbedding ? '● 已嵌入' : '○ 仅 FTS'}
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
      showToast('导入成功', { variant: 'success' });
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl
                    bg-[var(--ema-surface-1)] border border-[var(--ema-border)]">
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
                  className="p-3 rounded-xl bg-[var(--ema-surface-1)] border border-[var(--ema-border)] ema-stagger-in"
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

// ── KbModelSettings ───────────────────────────────────────────────────────────
// KB's own embed + rerank model choice (settings → kb.models), decoupled from
// LightRAG's lightrag-embed binding. Changing embed makes existing docs stale.

const NONE = '__none__';

function KbModelSettings(): JSX.Element {
  const [embedModels,  setEmbedModels]  = useState<AvailableBindingModel[]>([]);
  const [rerankModels, setRerankModels] = useState<AvailableBindingModel[]>([]);
  const [config, setConfig] = useState<KbModelsConfig>({});

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
    setConfig(next);
    try { await settingsApi.putKbModels(next); showToast('已保存', { variant: 'success' }); }
    catch { showToast('保存失败', { variant: 'danger' }); }
  }

  const opts = (models: AvailableBindingModel[], withNone: boolean) => [
    ...(withNone ? [{ value: NONE, label: '（不使用）' }] : []),
    ...models.map((m) => ({ value: `${m.providerConfigId}|${m.model}`, label: `${m.providerName} / ${m.model}` })),
  ];

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
        换<b>嵌入模型</b>会让已索引文档的向量与新查询<b>错配、检索骤减</b>——换完需对所有文档<b>重建索引</b>。
        重排模型可随时更换，无需重建。此处与「叙事模式」的 LightRAG 嵌入互不影响。
      </Callout>
    </section>
  );
}

// ── KnowledgeBaseTab ──────────────────────────────────────────────────────────

export function KnowledgeBaseTab(): JSX.Element {
  const documents = useKbStore((s) => s.documents);
  const loading   = useKbStore((s) => s.loading);
  const error     = useKbStore((s) => s.error);
  const [showIngest, setShowIngest] = useState(false);
  const [embedModel, setEmbedModel] = useState<string | undefined>();

  useEffect(() => {
    void useKbStore.getState().loadDocuments();
    void settingsApi.getKbModels().then((m) => setEmbedModel(m.embed?.model)).catch(() => { /* ignore */ });
  }, []);

  return (
    <div className="flex flex-col gap-6">

      {/* ── Retrieval models (embed + rerank) ── */}
      <KbModelSettings />

      {/* ── Document list ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">
            已导入文档
            {documents.length > 0 && (
              <span className="ml-2 text-xs text-[var(--ema-text-tertiary)]">({documents.length})</span>
            )}
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

        {showIngest && (
          <IngestForm onDone={() => setShowIngest(false)} />
        )}

        {error && (
          <Callout variant="danger" className="text-xs">{error}</Callout>
        )}

        {loading ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner size="md" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-28 gap-2 text-[var(--ema-text-tertiary)]">
            <span className="i-solar:database-bold text-2xl opacity-40" aria-hidden />
            <p className="text-sm">暂无文档，点击「导入文档」添加</p>
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <div className="flex flex-col gap-1.5 pr-2">
              {documents.map((doc, i) => (
                <div key={doc.id} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
                <DocumentRow
                  doc={doc}
                  currentEmbedModel={embedModel}
                  onDelete={() => void useKbStore.getState().loadDocuments()}
                />
                </div>
              ))}
            </div>
          </ScrollArea>
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
