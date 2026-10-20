import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  Markdown,
  MarketCard,
  SearchField,
  Select,
  Spinner,
} from '@ema-agent/ui';
import {
  skillsApi,
  type SkillMarketItem,
  type SkillMarketSourcesStatus,
  type SkillMarketDetailResult,
} from '../../api/skills.js';
import { showToast } from '../../lib/notifications/toast.js';
import { subscribeSystemEvent } from '../../lib/events/systemEventDispatcher.js';
import { useSkillStore } from '../../stores/skill.js';

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
  const [detailTarget, setDetailTarget] = useState<Pick<SkillMarketItem, 'source' | 'slug'> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [fileView, setFileView] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [pendingInstall, setPendingInstall] = useState<SkillMarketItem | null>(null);
  const installingMarketIds = useSkillStore(state => state.installingMarketIds);
  const [uninstalling, setUninstalling] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const listRequest = useRef(0);
  const fileRequest = useRef(0);
  const stateRef = useRef({ nextCursor, loadingMore, loading });
  stateRef.current = { nextCursor, loadingMore, loading };

  const loadPage = useCallback(async (cursor?: string): Promise<void> => {
    const request = ++listRequest.current;
    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setLoadingMore(false);
    }
    setError(null);

    try {
      const result = await skillsApi.marketList({
        ...(keyword ? { q: keyword } : {}),
        source,
        installed,
        ...(cursor ? { cursor } : {}),
        limit: PAGE_SIZE,
      });
      if (request !== listRequest.current) return;

      if (cursor) {
        setItems(current => [...current, ...result.items]);
      } else {
        setItems(result.items);
      }
      setNextCursor(result.nextCursor);
      setSources(result.sources);
    } catch (err) {
      if (request !== listRequest.current) return;
      setError(err instanceof Error ? err.message : '市场加载失败');
    } finally {
      if (request === listRequest.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [keyword, source, installed]);

  useEffect(() => {
    void loadPage();
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'skills_changed') void loadPage();
    });
    return () => {
      unsubscribe();
      // 筛选改变或页面离开后, 旧查询不能覆盖新列表或追加旧游标的数据.
      listRequest.current += 1;
    };
  }, [loadPage]);

  // 游标翻页:哨兵进入视口且还有下一页时追加.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting)) return;
      const { nextCursor: cursor, loadingMore: more, loading: first } = stateRef.current;
      if (!cursor || more || first) return;
      void loadPage(cursor);
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadPage, items.length]);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setFileView(null);
    setFileLoading(false);
    fileRequest.current += 1;
    if (!detailTarget) {
      setDetailLoading(false);
      return;
    }

    let request = 0;
    const refreshDetail = async (): Promise<void> => {
      const current = ++request;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const result = await skillsApi.marketDetail(detailTarget.source, detailTarget.slug);
        if (current === request) setDetail(result.skill);
      } catch (err) {
        if (current !== request) return;
        const message = err instanceof Error ? err.message : String(err);
        setDetailError(`详情加载失败: ${message}`);
      } finally {
        if (current === request) setDetailLoading(false);
      }
    };

    void refreshDetail();
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'skills_changed') void refreshDetail();
    });
    return () => {
      unsubscribe();
      request += 1;
      fileRequest.current += 1;
    };
  }, [detailTarget]);

  async function openFile(path: string): Promise<void> {
    if (!detail) return;
    const request = ++fileRequest.current;
    setFileLoading(true);
    try {
      const result = await skillsApi.marketFileContent(detail.source, detail.slug, path);
      if (request !== fileRequest.current) return;
      setFileView({ path, content: result.content, truncated: result.truncated });
    } catch (err) {
      if (request !== fileRequest.current) return;
      showToast(`文件读取失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      if (request === fileRequest.current) setFileLoading(false);
    }
  }

  function confirmInstall(): void {
    if (!pendingInstall) return;
    const { source, slug } = pendingInstall;
    setPendingInstall(null);
    void useSkillStore.getState().installFromMarket({ source, slug });
  }

  async function uninstallCurrent(): Promise<void> {
    if (!detail) return;
    setUninstalling(true);
    try {
      await skillsApi.marketUninstall({ source: detail.source, slug: detail.slug });
      showToast(`已卸载 ${detail.name}`, { variant: 'success' });
    } catch (err) {
      showToast(`卸载失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setUninstalling(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h1 className="text-base font-semibold text-[var(--ema-text-primary)]">技能市场</h1>
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
            onClick={() => void loadPage()}
            className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] transition-colors"
            aria-label="刷新市场"
          >
            <span className={loading ? 'i-lucide:loader-circle animate-spin text-base' : 'i-lucide:refresh-cw text-base'} aria-hidden />
          </button>
        </div>
      </div>

      <Callout variant="warn" className="text-xs shrink-0">
        技能来自社区第三方市场, 本应用不对内容做安全审计. 安装前请在详情里查看 SKILL.md 与配套文件.
      </Callout>

      <div className="flex shrink-0 flex-col gap-2">
        <div className="flex items-center gap-2">
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
        </div>
        <SearchField
          value={q}
          onChange={setQ}
          onSubmit={() => setKeyword(q.trim())}
          loading={loading}
          placeholder="按名称, 关键词搜索技能..."
          aria-label="搜索技能"
        />
      </div>

      {error ? (
        <div>
          <Callout variant="danger">{error}</Callout>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => void loadPage()}>重试</Button>
        </div>
      ) : loading && items.length === 0 ? (
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
                installing={installingMarketIds.has(item.id)}
                installDisabled={item.installState === 'not-installable'}
                installLabel={item.installState === 'not-installable' ? '不可安装' : '安装'}
                onInstall={() => setPendingInstall(item)}
              >
                <button type="button" className="w-full text-left" onClick={() => setDetailTarget(item)}>
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

      <Dialog
        open={detailTarget !== null}
        onOpenChange={open => {
          if (!open) setDetailTarget(null);
        }}
        title={detail ? detail.name : '加载中...'}
        widthClass="max-w-3xl"
      >
        {detailError && <Callout variant="danger">{detailError}</Callout>}
        {detailLoading && (
          <div className="flex justify-center py-12"><Spinner size="md" /></div>
        )}
        {!detailLoading && detail && (
          <DetailBody
            detail={detail}
            fileView={fileView}
            fileLoading={fileLoading}
            installing={installingMarketIds.has(detail.id)}
            uninstalling={uninstalling}
            onOpenFile={openFile}
            onCloseFile={() => setFileView(null)}
            onInstall={() => setPendingInstall(detail)}
            onUninstall={() => void uninstallCurrent()}
          />
        )}
      </Dialog>

      <Dialog
        open={pendingInstall !== null}
        onOpenChange={(open) => { if (!open) setPendingInstall(null); }}
        title={pendingInstall ? `安装 ${pendingInstall.name}?` : ''}
        widthClass="max-w-md"
      >
        {pendingInstall && (
          <div className="flex flex-col gap-3">
            <Callout variant="warn" className="text-xs">
              技能来自第三方市场, 可能包含指令与脚本. 安装后进入用户技能目录, 下一 Turn 起生效.
            </Callout>
            <p className="text-xs text-[var(--ema-text-tertiary)]">
              来源 {SOURCE_LABEL[pendingInstall.source] ?? pendingInstall.source}
              {pendingInstall.version ? ` · v${pendingInstall.version}` : ''}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPendingInstall(null)}>取消</Button>
              <Button variant="primary" size="sm" onClick={confirmInstall}>安装</Button>
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
        <p className="text-xs text-[var(--ema-text-tertiary)]">{detail.securityNote} (来源方声明, 非本应用审计)</p>
      )}
      {detail.notInstallableReason && detail.installState === 'not-installable' && (
        <Callout variant="warn" className="text-xs">该技能不可安装: {detail.notInstallableReason}</Callout>
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
          <Markdown source={detail.description || detail.summary || '(无描述)'} />
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
                {fileView.truncated && '\n...(内容过大已截断)'}
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
