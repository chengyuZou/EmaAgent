// Work Profile 知识库范围选择器:库页签 + 文档勾选两级结构,选择随会话切换重置。
import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  Button, Checkbox, IconButton, Popover, ScrollArea, Spinner, Tooltip, TooltipProvider,
} from '@ema-agent/ui';
import { knowledgeApi, type DocumentAsset, type KnowledgeLibrary } from '../../api/knowledge.js';

// ── KbButton ──────────────────────────────────────────────────────────────────
// Work Profile knowledge-base picker: select uploaded documents to scope kb_search.
// Appears/disappears with the Work toggle (ema-scale-in / ema-fade-out,
// delayed unmount so the exit keyframe plays). The panel is a Radix Popover
// (ema-anim-scale → both enter and exit animate, from style.css).

export function KbButton({
  visible, selectedScopes, onScopesChange,
}: {
  visible: boolean;
  selectedScopes: Map<string, string[]>;
  onScopesChange(scopes: Map<string, string[]>): void;
}): JSX.Element | null {
  const [mounted, setMounted] = useState(visible);
  const [open, setOpen]       = useState(false);

  useEffect(() => {
    if (visible) { setMounted(true); return; }
    setOpen(false);
    const t = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(t);
  }, [visible]);

  if (!mounted) return null;

  const count = [...selectedScopes.values()].reduce((s, ids) => s + ids.length, 0);

  return (
    <div className={visible ? 'ema-scale-in' : 'ema-fade-out'}>
      <TooltipProvider>
        <Popover
          open={open}
          onOpenChange={setOpen}
          side="top"
          align="start"
          widthClass="w-72"
          trigger={
            <span className="relative inline-flex">
              <Tooltip content={count > 0 ? `知识库 · 已选 ${count} 个文档` : '选择知识库'}>
                <span className="inline-flex">
                  <IconButton
                    variant={count > 0 ? 'primary' : 'default'}
                    size="sm"
                    icon="i-lucide:database"
                    label="选择知识库"
                    toggled={count > 0}
                  />
                </span>
              </Tooltip>
              {count > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-medium px-0.5 pointer-events-none bg-[var(--ema-primary)] text-[var(--ema-text-primary)]">
                  {count}
                </span>
              )}
            </span>
          }
        >
          <KbSelectorBody selectedScopes={selectedScopes} onScopesChange={onScopesChange} />
        </Popover>
      </TooltipProvider>
    </div>
  );
}

// ── KbSelectorBody ────────────────────────────────────────────────────────────
// Two-level picker: pick a KB library tab, then select documents within it.
// Switching tabs preserves selections from other KBs (selectedScopes is per-KB).

const KB_PAGE_SIZE = 20;

function KbDocList({
  kbId, selectedIds, onScopeChange,
}: {
  kbId: string;
  selectedIds: string[];
  onScopeChange(ids: string[]): void;
}): JSX.Element {
  const [items, setItems]           = useState<DocumentAsset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);
  const [loaded, setLoaded]         = useState(false);

  const loadPage = useCallback(async (cursor?: string): Promise<void> => {
    setLoading(true);
    try {
      const page = await knowledgeApi.listDocuments({ cursor, limit: KB_PAGE_SIZE, kbId });
      setItems((prev) => (cursor === undefined ? page.items : [...prev, ...page.items]));
      setNextCursor(page.nextCursor);
    } finally { setLoading(false); setLoaded(true); }
  }, [kbId]);

  useEffect(() => { void loadPage(undefined); }, [loadPage]);

  function toggle(id: string): void {
    onScopeChange(selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id]);
  }

  return (
    <div className="flex flex-col gap-1 ema-slide-down">
      <ScrollArea viewportClassName="max-h-44">
        <div className="flex flex-col gap-0.5 pr-1">
          {!loaded && loading ? (
            <div className="flex justify-center py-4 ema-fade-in"><Spinner size="sm" /></div>
          ) : items.length === 0 ? (
            <p className="text-xs py-3 text-center ema-fade-in text-[var(--ema-text-tertiary)]">
              此知识库暂无文档，去设置 → 知识库上传
            </p>
          ) : (
            items.map((doc) => {
              const checked = selectedIds.includes(doc.id);
              return (
                <div
                  key={doc.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-ema"
                  style={{ background: checked ? 'var(--ema-primary-muted)' : 'transparent' }}
                  onClick={() => toggle(doc.id)}
                >
                  <Checkbox checked={checked} className="pointer-events-none" label={doc.fileName} />
                  <span className="text-xs truncate flex-1 text-[var(--ema-text-secondary)]" title={doc.fileName}>
                    {doc.fileName}
                  </span>
                  {doc.status !== 'ready' && (
                    <span className="text-[10px] shrink-0 text-[var(--ema-text-tertiary)]">
                      {doc.status === 'failed' ? '错误' : '索引中'}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {nextCursor !== null && (
        <Button variant="ghost" size="sm" className="w-full ema-fade-in" disabled={loading}
                onClick={() => void loadPage(nextCursor)}>
          {loading ? <Spinner size="sm" /> : '加载更多'}
        </Button>
      )}
    </div>
  );
}

function KbSelectorBody({
  selectedScopes, onScopesChange,
}: {
  selectedScopes:  Map<string, string[]>;
  onScopesChange(scopes: Map<string, string[]>): void;
}): JSX.Element {
  const [libs, setLibs]             = useState<KnowledgeLibrary[]>([]);
  const [libsLoaded, setLibsLoaded] = useState(false);
  const [shownLibId, setShownLibId] = useState<string | null>(null);

  useEffect(() => {
    void knowledgeApi.listLibs().then((list) => {
      setLibs(list.items);
      setLibsLoaded(true);
      const active = list.items.find((l) => l.isActive);
      if (active) setShownLibId(active.id);
      else if (list.items[0]) setShownLibId(list.items[0].id);
    }).catch(() => { setLibsLoaded(true); });
  }, []);

  function handleScopeChange(kbId: string, ids: string[]): void {
    const next = new Map(selectedScopes);
    if (ids.length === 0) next.delete(kbId);
    else next.set(kbId, ids);
    onScopesChange(next);
  }

  function clearAll(): void {
    onScopesChange(new Map());
  }

  const totalCount = [...selectedScopes.values()].reduce((s, ids) => s + ids.length, 0);
  const shownLib   = libs.find((l) => l.id === shownLibId);

  return (
    <div className="flex flex-col gap-2">
      {/* ── Header row ── */}
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-medium text-[var(--ema-text-secondary)]">知识库</p>
        {totalCount > 0 && (
          <Button
            variant="ghost"
            className="text-xs transition-colors hover:text-[var(--ema-primary)] text-[var(--ema-text-tertiary)]"
            onClick={clearAll}
          >清空全部</Button>
        )}
      </div>

      {!libsLoaded ? (
        <div className="flex justify-center py-3 ema-fade-in"><Spinner size="sm" /></div>
      ) : libs.length === 0 ? (
        <p className="text-xs py-3 text-center ema-fade-in text-[var(--ema-text-tertiary)]">
          暂无知识库，去设置 → 知识库创建
        </p>
      ) : (
        <>
          {/* ── Library tabs — switching preserves other KBs' selections ── */}
          {libs.length > 1 && (
            <div className="flex flex-wrap gap-1 ema-slide-up">
              {libs.map((lib) => {
                const libCount = selectedScopes.get(lib.id)?.length ?? 0;
                return (
                  <Button
                    variant="ghost"
                    key={lib.id}
                    className={`text-xs px-2 py-0.5 rounded-full font-normal transition-ema relative ${lib.id === shownLibId ? 'bg-[var(--ema-primary)] text-[var(--ema-text-on-primary)]' : 'bg-[var(--ema-surface-2)] text-[var(--ema-text-secondary)]'}`}
                    onClick={() => setShownLibId(lib.id)}
                  >
                    {lib.name}
                    {lib.isActive && <span className="ml-1 opacity-60 text-[9px]">●</span>}
                    {libCount > 0 && (
                      <span className="ml-1 text-[9px] font-mono opacity-80">{libCount}</span>
                    )}
                  </Button>
                );
              })}
            </div>
          )}

          {shownLib && (
            <KbDocList
              key={shownLib.id}
              kbId={shownLib.id}
              selectedIds={selectedScopes.get(shownLib.id) ?? []}
              onScopeChange={(ids) => handleScopeChange(shownLib.id, ids)}
            />
          )}
        </>
      )}
    </div>
  );
}
