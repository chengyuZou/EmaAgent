// 技能市场子页:聚合 SkillHub/ClawHub 浏览(搜索/来源/安装状态筛选 + 游标翻页)、
// 详情(文档/文件)、并发安装(按卡片各自转圈)与卸载。页面自持状态,不走全局 Store。
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  Badge, Button, Callout, Dialog, EmptyState, Input, MarketCard, ScrollArea, Select, Spinner,
} from '@ema-agent/ui';
import {
  skillsApi,
  type SkillMarketItem,
  type SkillMarketSourcesStatus,
  type SkillMarketDetailResult,
} from '../../api/skills.js';
import { showToast } from '../../lib/toast.js';
import { Markdown } from '../../markdown/renderer.js';

type SourceFilter = 'all' | 'skillhub' | 'clawhub';
type InstalledFilter = 'all' | 'installed' | 'installable';
type MarketDetail = SkillMarketDetailResult['skill'];

const SOURCE_LABEL: Record<string, string> = { skillhub: 'SkillHub', clawhub: 'ClawHub' };
const PAGE_SIZE = 24;

function formatDownloads(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SkillMarketPage(): JSX.Element {
  const [items, setItems] = useState<SkillMarketItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sources, setSources] = useState<SkillMarketSourcesStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [keyword, setKeyword] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [installed, setInstalled] = useState<InstalledFilter>('all');

  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fileView, setFileView] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [pendingInstall, setPendingInstall] = useState<SkillMarketItem | null>(null);
  /** 按技能 id 各自安装中:确认弹窗关掉后安装继续,不阻塞其他卡片。 */
  const [installing, setInstalling] = useState<ReadonlySet<string>>(new Set());
  const [uninstalling, setUninstalling] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ nextCursor, loadingMore, loading });
  stateRef.current = { nextCursor, loadingMore, loading };

  const load = useCallback(async (cursor?: string) => {
    const result = await skillsApi.marketList({
      ...(keyword ? { q: keyword } : {}),
      source,
      installed,
      ...(cursor ? { cursor } : {}),
      limit: PAGE_SIZE,
    });
    if (cursor) {
      setItems(prev => [...prev, ...result.items]);
    } else {
      setItems(result.items);
    }
    setNextCursor(result.nextCursor);
    setSources(result.sources);
  }, [keyword, source, installed]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '市场加载失败');
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => { void reload(); }, [reload]);

  // 游标翻页:哨兵进入视口且还有下一页时追加。
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting)) return;
      const { nextCursor: cursor, loadingMore: more, loading: first } = stateRef.current;
      if (!cursor || more || first) return;
      setLoadingMore(true);
      void load(cursor).catch(() => {}).finally(() => setLoadingMore(false));
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [load, items.length]);

  async function openDetail(item: Pick<SkillMarketItem, 'source' | 'slug'>): Promise<void> {
    setDetailLoading(true);
    setFileView(null);
    try {
      const result = await skillsApi.marketDetail(item.source, item.slug);
      setDetail(result.skill);
    } catch (err) {
      showToast(`详情加载失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setDetailLoading(false);
    }
  }

  async function openFile(path: string): Promise<void> {
    if (!detail) return;
    setFileLoading(true);
    try {
      const result = await skillsApi.marketFileContent(detail.source, detail.slug, path);
      setFileView({ path, content: result.content, truncated: result.truncated });
    } catch (err) {
      showToast(`文件读取失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setFileLoading(false);
    }
  }

  // 安装:确认后立即返回,后台完成;该卡转圈,其他卡片不受影响。
  async function confirmInstall(): Promise<void> {
    if (!pendingInstall) return;
    const { source: src, slug, id } = pendingInstall;
    setPendingInstall(null);
    setInstalling(prev => new Set(prev).add(id));
    try {
      const result = await skillsApi.marketInstall({ source: src as 'skillhub' | 'clawhub', slug });
      showToast(`已安装 ${result.name},下一根对话 Turn 起生效`, { variant: 'success' });
      await reload();
      if (detail?.id === id) await openDetail(detail);
    } catch (err) {
      showToast(`安装失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setInstalling(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function uninstallCurrent(): Promise<void> {
    if (!detail) return;
    setUninstalling(true);
    try {
      await skillsApi.marketUninstall({ source: detail.source, slug: detail.slug });
      showToast(`已卸载 ${detail.name}`, { variant: 'success' });
      await reload();
      await openDetail(detail);
    } catch (err) {
      showToast(`卸载失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setUninstalling(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 页头:标题 + 来源状态 + 刷新 */}
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">技能市场</h2>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">浏览并安装来自 SkillHub 与 ClawHub 的技能</p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {(['skillhub', 'clawhub'] as const).map((key) => {
            const status = sources?.[key]?.status;
            const failed = status === 'failed' || status === 'degraded';
            return (
              <span key={key} className="flex items-center gap-1.5 text-[var(--ema-text-tertiary)]">
                <span className={`size-2 rounded-full ${failed ? 'bg-[var(--ema-danger)]' : 'bg-[var(--ema-success)]'}`} />
                {SOURCE_LABEL[key]} {status === 'cached' ? '缓存' : failed ? '异常' : '正常'}
              </span>
            );
          })}
          <button
            type="button"
            onClick={() => void reload()}
            className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] transition-colors"
            aria-label="刷新市场"
          >
            <span className={loading ? 'i-lucide:loader-circle animate-spin text-base' : 'i-lucide:refresh-cw text-base'} aria-hidden />
          </button>
        </div>
      </div>

      <Callout variant="warn" className="text-xs shrink-0">
        技能来自社区第三方市场,本应用不对内容做安全审计。安装前请在详情里查看 SKILL.md 与配套文件。
      </Callout>

      {/* 筛选行 */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex-1">
          <Input
            placeholder="按名称、关键词搜索技能…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setKeyword(q.trim()); }}
          />
        </div>
        <Select
          value={source}
          onChange={(v) => setSource(v as SourceFilter)}
          options={[
            { value: 'all', label: '全部来源' },
            { value: 'skillhub', label: 'SkillHub' },
            { value: 'clawhub', label: 'ClawHub' },
          ]}
        />
        <Select
          value={installed}
          onChange={(v) => setInstalled(v as InstalledFilter)}
          options={[
            { value: 'all', label: '全部技能' },
            { value: 'installed', label: '已安装' },
            { value: 'installable', label: '未安装' },
          ]}
        />
        <Button variant="secondary" size="sm" onClick={() => setKeyword(q.trim())}>搜索</Button>
      </div>

      {/* 卡片网格 */}
      {error ? (
        <div>
          <Callout variant="danger">{error}</Callout>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => void reload()}>重试</Button>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-16"><Spinner size="lg" /></div>
      ) : items.length === 0 ? (
        <EmptyState icon="i-mdi:store-outline" title="没有符合条件的技能" hint="换个关键词或筛选条件" className="py-16" />
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pb-2">
            {items.map((item, i) => (
              <MarketCard
                key={item.id}
                index={i % PAGE_SIZE}
                decorate="ema-card-decorate--diamond"
                installed={item.installState === 'installed'}
                installing={installing.has(item.id)}
                installDisabled={item.installState === 'not-installable'}
                installLabel={item.installState === 'not-installable' ? '不可安装' : '安装'}
                onInstall={() => setPendingInstall(item)}
              >
                <button type="button" className="w-full text-left" onClick={() => void openDetail(item)}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{item.name}</span>
                    {item.version && <Badge variant="neutral">v{item.version}</Badge>}
                    <Badge variant="neutral">{SOURCE_LABEL[item.source] ?? item.source}</Badge>
                  </div>
                  {item.summary && (
                    <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 line-clamp-2">{item.summary}</p>
                  )}
                  <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[var(--ema-text-tertiary)]">
                    {item.tags.slice(0, 3).map((tag: string) => <span key={tag}>#{tag}</span>)}
                    <span className="ml-auto inline-flex items-center gap-1">
                      <span className="i-lucide:download text-[10px]" aria-hidden />
                      {formatDownloads(item.downloads)}
                    </span>
                  </div>
                </button>
              </MarketCard>
            ))}
          </div>
          <div ref={sentinelRef} className="flex justify-center py-4">
            {loadingMore && <Spinner size="sm" />}
            {!nextCursor && items.length > 0 && (
              <span className="text-xs text-[var(--ema-text-tertiary)]">没有更多了</span>
            )}
          </div>
        </>
      )}

      {/* 详情弹窗 */}
      <Dialog
        open={detail !== null || detailLoading}
        onOpenChange={(open) => { if (!open) { setDetail(null); setFileView(null); } }}
        title={detail ? detail.name : '加载中…'}
        widthClass="max-w-3xl"
      >
        {detailLoading || !detail ? (
          <div className="flex justify-center py-12"><Spinner size="md" /></div>
        ) : (
          <DetailBody
            detail={detail}
            fileView={fileView}
            fileLoading={fileLoading}
            installing={installing.has(detail.id)}
            uninstalling={uninstalling}
            onOpenFile={openFile}
            onCloseFile={() => setFileView(null)}
            onInstall={() => setPendingInstall(detail)}
            onUninstall={() => void uninstallCurrent()}
          />
        )}
      </Dialog>

      {/* 安装确认 */}
      <Dialog
        open={pendingInstall !== null}
        onOpenChange={(open) => { if (!open) setPendingInstall(null); }}
        title={pendingInstall ? `安装 ${pendingInstall.name}?` : ''}
        widthClass="max-w-md"
      >
        {pendingInstall && (
          <div className="flex flex-col gap-3">
            <Callout variant="warn" className="text-xs">
              技能来自第三方市场,可能包含指令与脚本。安装后进用户技能目录,下一根对话 Turn 起生效。
            </Callout>
            <p className="text-xs text-[var(--ema-text-tertiary)]">
              来源 {SOURCE_LABEL[pendingInstall.source] ?? pendingInstall.source}
              {pendingInstall.version ? ` · v${pendingInstall.version}` : ''}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPendingInstall(null)}>取消</Button>
              <Button variant="primary" size="sm" onClick={() => void confirmInstall()}>安装</Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function DetailBody(props: {
  detail: MarketDetail;
  fileView: { path: string; content: string; truncated: boolean } | null;
  fileLoading: boolean;
  installing: boolean;
  uninstalling: boolean;
  onOpenFile(path: string): void;
  onCloseFile(): void;
  onInstall(): void;
  onUninstall(): void;
}): JSX.Element {
  const { detail, fileView, fileLoading, installing, uninstalling, onOpenFile, onCloseFile, onInstall, onUninstall } = props;
  const [tab, setTab] = useState<'doc' | 'files'>('doc');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap text-xs text-[var(--ema-text-tertiary)]">
        {detail.version && <Badge variant="neutral">v{detail.version}</Badge>}
        <Badge variant="neutral">{SOURCE_LABEL[detail.source] ?? detail.source}</Badge>
        {detail.license && <Badge variant="neutral">{detail.license}</Badge>}
        <span>{detail.files.length} 个文件 · {formatBytes(detail.totalSize)}</span>
        <span className="inline-flex items-center gap-1">
          <span className="i-lucide:download text-[10px]" aria-hidden />{formatDownloads(detail.downloads)}
        </span>
      </div>
      {detail.securityNote && (
        <p className="text-xs text-[var(--ema-text-tertiary)]">{detail.securityNote}（来源方声明，非本应用审计）</p>
      )}
      {detail.notInstallableReason && detail.installState === 'not-installable' && (
        <Callout variant="warn" className="text-xs">该技能不可安装：{detail.notInstallableReason}</Callout>
      )}

      <div className="flex gap-2 border-b border-[var(--ema-border)]">
        {(['doc', 'files'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-3 py-1.5 text-xs transition-colors ${tab === key
              ? 'text-[var(--ema-primary)] border-b-2 border-[var(--ema-primary)]'
              : 'text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]'}`}
          >
            {key === 'doc' ? '文档' : `文件 (${detail.files.length})`}
          </button>
        ))}
      </div>

      {tab === 'doc' ? (
        <div className="max-h-[46vh] overflow-auto rounded-lg p-3 bg-[var(--ema-surface-0)] border border-[var(--ema-border)]">
          <Markdown source={detail.description || detail.summary || '（无描述）'} />
        </div>
      ) : (
        <div className="max-h-[46vh] overflow-auto rounded-lg bg-[var(--ema-surface-0)] border border-[var(--ema-border)]">
          {fileView ? (
            <div>
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--ema-border)]">
                <span className="font-mono text-xs text-[var(--ema-text-secondary)]">{fileView.path}</span>
                <Button variant="ghost" size="sm" onClick={onCloseFile}>返回</Button>
              </div>
              <pre className="p-3 text-[11px] font-mono whitespace-pre-wrap break-all text-[var(--ema-text-secondary)]">
                {fileView.content}
                {fileView.truncated && '\n…(内容过大已截断)'}
              </pre>
            </div>
          ) : (
            <div className="flex flex-col">
              {fileLoading && <div className="flex justify-center py-6"><Spinner size="sm" /></div>}
              {detail.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  disabled={file.tooBig || fileLoading}
                  onClick={() => void onOpenFile(file.path)}
                  className="flex items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-[var(--ema-surface-2)] transition-colors disabled:opacity-50"
                >
                  <span className="font-mono text-[var(--ema-text-secondary)]">{file.path}</span>
                  <span className="text-[var(--ema-text-tertiary)]">{formatBytes(file.size)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {detail.installState === 'installed' ? (
          <Button variant="danger" size="sm" loading={uninstalling} onClick={onUninstall}>卸载</Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            loading={installing}
            disabled={detail.installState !== 'installable'}
            onClick={onInstall}
          >
            安装
          </Button>
        )}
      </div>
    </div>
  );
}
