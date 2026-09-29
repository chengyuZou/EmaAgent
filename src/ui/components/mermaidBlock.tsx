// 公共 Markdown 的 Mermaid 代码块: 官方库负责语法、布局和 SVG 清洗, 这里只管理 React 生命周期.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { Button } from './Button.js';
import { Spinner } from './Spinner.js';
import { readMermaidAppearance, renderMermaid } from './mermaidRender.js';

interface DiagramResult {
  key: string;
  svg: string | null;
}

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | undefined;

function readThemeStamp(): string {
  const root = document.documentElement;
  return `${root.dataset.theme ?? 'dark'}:${root.getAttribute('style') ?? ''}`;
}

function serverThemeStamp(): string {
  return 'dark:';
}

function subscribeTheme(onChange: () => void): () => void {
  themeListeners.add(onChange);
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      for (const listener of themeListeners) listener();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  }
  return () => {
    themeListeners.delete(onChange);
    if (themeListeners.size === 0) {
      themeObserver?.disconnect();
      themeObserver = undefined;
    }
  };
}

export const MermaidBlock = memo(function MermaidBlock({ source, pending }: { source: string; pending: boolean }): JSX.Element {
  const stamp = useSyncExternalStore(subscribeTheme, readThemeStamp, serverThemeStamp);
  const id = `ema-mermaid-${useId().replace(/[^\w-]/g, '')}`;
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<DiagramResult | null>(null);
  const [showSource, setShowSource] = useState(false);
  const theme = useMemo(() => visible ? readMermaidAppearance(stamp) : null, [visible, stamp]);
  const key = useMemo(() => JSON.stringify([source, theme]), [source, theme]);
  const current = result?.key === key ? result : null;
  const loading = pending || current === null;
  const svg = current?.svg;
  const toggleSource = useCallback(() => setShowSource(value => !value), []);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '600px' });
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (pending || !theme) return;
    let disposed = false;
    void renderMermaid(id, source, theme).then(svg => {
      if (!disposed) setResult({ key, svg });
    });
    return () => { disposed = true; };
  }, [id, source, theme, pending, key]);

  return (
    <div ref={host} className="markdown-mermaid" aria-busy={loading}>
      <div className="markdown-mermaid-toolbar">
        <span>Mermaid</span>
        {loading && (
          <span className="markdown-mermaid-status" role="status">
            <Spinner size="sm" />{pending ? '等待图表生成完整…' : '正在渲染图表…'}
          </span>
        )}
        {svg && (
          <Button variant="ghost" size="sm" onClick={toggleSource} aria-pressed={showSource}>
            {showSource ? '查看图表' : '查看源码'}
          </Button>
        )}
      </div>
      {svg && (
        <div
          className="markdown-mermaid-diagram"
          hidden={showSource}
          role="img"
          aria-label="Mermaid 图表"
          // 只插入 strict 模式下经 Mermaid 内置 DOMPurify 清洗的 SVG, 不绑定图中脚本回调.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {(!svg || showSource) && <pre><code className="language-mermaid">{source}</code></pre>}
      {!loading && !svg && <p className="markdown-mermaid-error" role="status">图表暂时无法渲染, 显示源码. 请检查语法.</p>}
    </div>
  );
});
