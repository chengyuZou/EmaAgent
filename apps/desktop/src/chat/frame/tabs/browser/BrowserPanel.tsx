// 用 React 工具栏控制一个 Tauri 原生子 WebView，并同步它在 Dock 中的真实位置。
import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import { tauriBridge, type BrowserBounds } from '../../../../lib/tauri-bridge.js';
import { useDockTabs } from '../../dockTabs.js';

export interface BrowserPanelProps {
  readonly sessionId: string;
  readonly browserId: string;
  readonly initialUrl: string;
  readonly visible: boolean;
}

export function BrowserPanel({
  sessionId, browserId, initialUrl, visible,
}: BrowserPanelProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const initialUrlRef = useRef(initialUrl);
  const openedRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const latestBoundsRef = useRef<BrowserBounds | null>(null);
  const [address, setAddress] = useState(initialUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateTab = useDockTabs((state) => state.updateBrowserTab);

  useEffect(() => {
    let disposed = false;
    let unlisten = () => {};
    void tauriBridge.listenBrowserEvents((event) => {
      if (event.browserId !== browserId) return;
      if (event.type === 'loading') {
        setLoading(event.loading);
      } else if (event.type === 'locationChanged') {
        setAddress(event.url);
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
        if (openedRef.current) void tauriBridge.setBrowserBounds(browserId, bounds).catch(() => {});
      });
    };
    syncBounds();
    const observer = new ResizeObserver(syncBounds);
    observer.observe(host);
    window.addEventListener('resize', syncBounds);

    const bounds = boundsOf(host);
    latestBoundsRef.current = bounds;
    void tauriBridge.openBrowser(browserId, initialUrlRef.current, bounds)
      .then(() => {
        openedRef.current = true;
        return tauriBridge.setBrowserVisible(browserId, visibleRef.current);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : '浏览器打开失败');
      });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
      if (openedRef.current) void tauriBridge.setBrowserVisible(browserId, false).catch(() => {});
    };
  }, [browserId]);

  useEffect(() => {
    if (!openedRef.current) return;
    if (visible && latestBoundsRef.current) {
      void tauriBridge.setBrowserBounds(browserId, latestBoundsRef.current)
        .then(() => tauriBridge.setBrowserVisible(browserId, true))
        .catch(() => {});
    } else {
      void tauriBridge.setBrowserVisible(browserId, false).catch(() => {});
    }
  }, [browserId, visible]);

  const navigate = (event: FormEvent): void => {
    event.preventDefault();
    const url = normalizeUrl(address);
    if (!url) {
      setError('请输入有效的网址');
      return;
    }
    setError(null);
    setAddress(url);
    void tauriBridge.navigateBrowser(browserId, url).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : '网页打开失败');
    });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[var(--ema-surface-1)]">
      <form className="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--ema-border)]" onSubmit={navigate}>
        <ToolbarButton icon="i-lucide:arrow-left" label="后退" onClick={() => void tauriBridge.browserBack(browserId)} />
        <ToolbarButton icon="i-lucide:arrow-right" label="前进" onClick={() => void tauriBridge.browserForward(browserId)} />
        <ToolbarButton icon={loading ? 'i-svg-spinners:90-ring-with-bg' : 'i-lucide:rotate-cw'} label="刷新" onClick={() => void tauriBridge.reloadBrowser(browserId)} />
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          className="min-w-0 flex-1 h-7 rounded-md border px-2 text-xs outline-none bg-[var(--ema-surface-2)] border-[var(--ema-border)] focus:border-[var(--ema-primary)] text-[var(--ema-text-primary)]"
          aria-label="网页地址"
        />
        <ToolbarButton icon="i-lucide:external-link" label="在系统浏览器打开" onClick={() => void tauriBridge.openUrl(address)} />
      </form>
      {error && <div className="px-3 py-1.5 text-[11px] text-[var(--ema-danger)]">{error}</div>}
      <div ref={hostRef} className="relative flex-1 min-h-0" />
    </div>
  );
}

function ToolbarButton({ icon, label, onClick }: { icon: string; label: string; onClick(): void }): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="size-7 shrink-0 rounded-md flex items-center justify-center text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-3)]"
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
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
