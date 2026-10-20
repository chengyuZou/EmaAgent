import { useLayoutEffect, useMemo, useState, type JSX } from 'react';

interface HtmlPreviewProps {
  readonly source: string;
  readonly title: string;
}

export function HtmlPreview({ source, title }: HtmlPreviewProps): JSX.Element {
  const [scrollbarColors, setScrollbarColors] = useState('');

  useLayoutEffect(() => {
    const root = document.documentElement;
    function readColors(): void {
      const style = getComputedStyle(root);
      const thumb = style.getPropertyValue('--ema-scrollbar-thumb').trim() || '#718096';
      const hover = style.getPropertyValue('--ema-scrollbar-thumb-hover').trim() || '#4a5568';
      setScrollbarColors(`:root {
        --ema-scrollbar-thumb: ${thumb};
        --ema-scrollbar-thumb-hover: ${hover};
      }`);
    }
    readColors();
    const observer = new MutationObserver(readColors);
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'data-theme', 'class'] });
    return () => observer.disconnect();
  }, []);

  const preview = useMemo(() => {
    if (typeof DOMParser === 'undefined') return source;
    const document = new DOMParser().parseFromString(source, 'text/html');
    const style = document.createElement('style');
    // iframe 不继承主页面 CSS. 只传入滚动条颜色和外观, 不覆盖被预览页面的内容样式.
    // sandbox 仍禁用脚本和同源访问, 不为主题同步开放预览文档权限.
    style.textContent = `${scrollbarColors}
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
      ::-webkit-scrollbar-thumb { background: transparent; border-radius: 999px; }
      *:hover::-webkit-scrollbar-thumb { background: var(--ema-scrollbar-thumb); }
      ::-webkit-scrollbar-thumb:hover { background: var(--ema-scrollbar-thumb-hover); }
      * { scrollbar-width: thin; scrollbar-color: transparent transparent; }
      *:hover { scrollbar-color: var(--ema-scrollbar-thumb) transparent; }
    `;
    document.head.append(style);
    const doctype = document.doctype
      ? new XMLSerializer().serializeToString(document.doctype)
      : '';
    return `${doctype}${document.documentElement.outerHTML}`;
  }, [source, scrollbarColors]);

  return (
    <iframe
      sandbox=""
      srcDoc={preview}
      title={title}
      className="ema-html-preview"
    />
  );
}
