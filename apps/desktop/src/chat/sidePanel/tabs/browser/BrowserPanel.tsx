// 用 React 工具栏控制一个 Tauri 原生子 WebView，并同步它在 Dock 中的真实位置。
import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import { tauriBridge, type BrowserBounds } from '../../../../lib/tauri-bridge.js';
import { useSessionPanelStore } from '../../../../stores/sessionPanel.js';

export interface BrowserPanelProps {
  readonly sessionId: string;
  readonly browserId: string;
  readonly url: string | null;
  readonly visible: boolean;
}

export function BrowserPanel({
  sessionId, browserId, url, visible,
}: BrowserPanelProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const restoredUrlRef = useRef(url);
  const nativeReadyRef = useRef(false);
  const openingRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const latestBoundsRef = useRef<BrowserBounds | null>(null);
  const currentUrlRef = useRef(url);
  const editingAddressRef = useRef(false);
  const [address, setAddress] = useState(url ?? '');
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateTab = useSessionPanelStore((state) => state.updateBrowserTab);

  const showError = useCallback((cause: unknown, message: string): void => {
    setError(cause instanceof Error ? cause.message : message);
  }, []);

  const openPage = useCallback((targetUrl: string): Promise<void> => {
    if (openingRef.current) return openingRef.current;
    const host = hostRef.current;
    if (!host) return Promise.reject(new Error('浏览器容器尚未就绪'));

    const bounds = latestBoundsRef.current ?? boundsOf(host);
    latestBoundsRef.current = bounds;
    const opening = tauriBridge.openBrowser(browserId, targetUrl, bounds)
      .then(() => {
        nativeReadyRef.current = true;
        if (mountedRef.current) setReady(true);
      });
    openingRef.current = opening;
    void opening.finally(() => {
      if (openingRef.current === opening) openingRef.current = null;
    }).catch(() => {});
    return opening;
  }, [browserId]);

  useEffect(() => {
    let disposed = false;
    let unlisten = () => {};
    void tauriBridge.listenBrowserEvents((event) => {
      if (event.browserId !== browserId) return;
      if (event.type === 'loading') {
        setLoading(event.loading);
      } else if (event.type === 'locationChanged') {
        currentUrlRef.current = event.url;
        if (!editingAddressRef.current) setAddress(event.url);
        updateTab(sessionId, browserId, { url: event.url });
      } else {
        updateTab(sessionId, browserId, { title: event.title });
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [browserId, sessionId, updateTab]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    mountedRef.current = true;
    let frame = 0;
    const syncBounds = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect();
        const bounds = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
        latestBoundsRef.current = bounds;
        if (nativeReadyRef.current) void tauriBridge.setBrowserBounds(browserId, bounds).catch(() => {});
      });
    };
    syncBounds();
    const observer = new ResizeObserver(syncBounds);
    observer.observe(host);
    window.addEventListener('resize', syncBounds);
    window.addEventListener('scroll', syncBounds, true);

    latestBoundsRef.current = boundsOf(host);
    let disposed = false;
    if (restoredUrlRef.current) {
      void openPage(restoredUrlRef.current).catch((cause: unknown) => {
        if (!disposed) showError(cause, '浏览器打开失败');
      });
    }

    return () => {
      disposed = true;
      mountedRef.current = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
      window.removeEventListener('scroll', syncBounds, true);
      if (nativeReadyRef.current) void tauriBridge.setBrowserVisible(browserId, false).catch(() => {});
    };
  }, [browserId, openPage, showError]);

  useEffect(() => {
    if (!ready) return;
    if (visible && latestBoundsRef.current) {
      void tauriBridge.setBrowserBounds(browserId, latestBoundsRef.current)
        .then(() => {
          if (mountedRef.current && visibleRef.current) {
            return tauriBridge.setBrowserVisible(browserId, true);
          }
          return undefined;
        })
        .catch((cause: unknown) => showError(cause, '浏览器显示失败'));
    } else {
      void tauriBridge.setBrowserVisible(browserId, false).catch(() => {});
    }
  }, [browserId, ready, showError, visible]);

  const navigate = (event: FormEvent): void => {
    event.preventDefault();
    const url = normalizeUrl(address);
    if (!url) {
      setError('请输入有效的网址');
      return;
    }
    setError(null);
    setAddress(url);
    const previousUrl = currentUrlRef.current;
    const operation = nativeReadyRef.current
      ? tauriBridge.navigateBrowser(browserId, url)
      : openingRef.current
        ? openingRef.current.then(() => tauriBridge.navigateBrowser(browserId, url))
        : openPage(url);
    void operation.then(() => {
      const pageUrl = currentUrlRef.current === previousUrl
        ? url
        : currentUrlRef.current ?? url;
      currentUrlRef.current = pageUrl;
      updateTab(sessionId, browserId, { url: pageUrl });
    }).catch((cause: unknown) => showError(cause, '网页打开失败'));
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[var(--ema-surface-1)]">
      <form className="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--ema-border)]" onSubmit={navigate}>
        <ToolbarButton
          icon="i-lucide:arrow-left"
          label="后退"
          disabled={!ready}
          onClick={() => void tauriBridge.browserBack(browserId).catch(cause => showError(cause, '后退失败'))}
        />
        <ToolbarButton
          icon="i-lucide:arrow-right"
          label="前进"
          disabled={!ready}
          onClick={() => void tauriBridge.browserForward(browserId).catch(cause => showError(cause, '前进失败'))}
        />
        <ToolbarButton
          icon={loading ? 'i-svg-spinners:90-ring-with-bg' : 'i-lucide:rotate-cw'}
          label="刷新"
          disabled={!ready}
          onClick={() => void tauriBridge.reloadBrowser(browserId).catch(cause => showError(cause, '刷新失败'))}
        />
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={() => { editingAddressRef.current = true; }}
          onBlur={() => {
            editingAddressRef.current = false;
            window.setTimeout(() => {
              if (!editingAddressRef.current) setAddress(currentUrlRef.current ?? '');
            }, 0);
          }}
          placeholder="输入网址"
          className="min-w-0 flex-1 h-7 rounded-md border px-2 text-xs outline-none bg-[var(--ema-surface-2)] border-[var(--ema-border)] focus:border-[var(--ema-primary)] text-[var(--ema-text-primary)]"
          aria-label="网页地址"
        />
        <ToolbarButton
          icon="i-lucide:external-link"
          label="在系统浏览器打开"
          disabled={!address.trim()}
          onClick={() => {
            const targetUrl = normalizeUrl(address);
            if (!targetUrl) {
              setError('请输入有效的网址');
              return;
            }
            void tauriBridge.openUrl(targetUrl).catch(cause => showError(cause, '打开系统浏览器失败'));
          }}
        />
      </form>
      {error && <div className="px-3 py-1.5 text-[11px] text-[var(--ema-danger)]">{error}</div>}
      <div ref={hostRef} className="relative flex-1 min-h-0">
        {!url && !ready && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--ema-text-tertiary)]">
            <span className="i-lucide:globe text-3xl" aria-hidden />
            <p className="text-sm text-[var(--ema-text-primary)]">开始浏览</p>
            <p className="text-xs">输入 URL 以打开页面</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  icon,
  label,
  disabled = false,
  onClick,
}: {
  icon: string;
  label: string;
  disabled?: boolean;
  onClick(): void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className="size-7 shrink-0 rounded-md flex items-center justify-center text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-3)] disabled:opacity-40 disabled:hover:bg-transparent"
      onClick={onClick}
    >
      <span className={`${icon} text-sm`} aria-hidden />
    </button>
  );
}

function boundsOf(element: HTMLElement): BrowserBounds {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
