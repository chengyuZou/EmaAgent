import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { Button, Dialog, Markdown, MarkdownRendererProvider } from '@ema-agent/ui';
import { ServerImage } from '../../lib/images/serverImage.js';

export function resourceTableText(value: string): string {
  return value.replace(/\r?\n/gu, ' ').replace(/[\\|`*_{}\[\]<>]/gu, char => '\\' + char);
}

export function ResourceImage({ src, name, className }: {
  src: string;
  name: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={className}>
      <ServerImage
        path={src}
        alt={name}
        className="h-full w-full object-contain"
      />
    </div>
  );
}

export function ResourcePreview({ image, onClose }: {
  image: { src: string; name: string } | null;
  onClose(): void;
}): JSX.Element {
  return (
    <Dialog
      open={image !== null}
      onOpenChange={open => { if (!open) onClose(); }}
      title={image?.name ?? '图片预览'}
      widthClass="max-w-4xl"
    >
      {image && <ResourceImage key={image.src} {...image} className="h-[65vh]" />}
    </Dialog>
  );
}

/** 用户描述先转义; 图片只接受本页生成的资源地址, 编辑链接只定位当前资源. */
export function ResourceOverview({ source, onEdit, onPreview }: {
  source: string;
  onEdit(name: string): void;
  onPreview(src: string, name: string): void;
}): JSX.Element {
  return (
    <MarkdownRendererProvider
      urlTransform={url => url.startsWith('/api/characters/') || url.startsWith('#edit-') ? url : ''}
      components={{
        img: ({ src, alt }) => src ? (
          <Button
            variant="ghost"
            className="ema-resource-table-image"
            aria-label={`查看 ${alt ?? '图片'}`}
            onClick={() => onPreview(src, alt ?? '图片')}
          >
            <ResourceImage src={src} name={alt ?? '图片'} className="h-full w-full" />
          </Button>
        ) : null,
        a: ({ href, children }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (href?.startsWith('#edit-')) onEdit(decodeURIComponent(href.slice(6)));
            }}
          >
            {children}
          </Button>
        ),
      }}
    >
      <Markdown source={source} className="ema-resource-table" />
    </MarkdownRendererProvider>
  );
}

/** 离开动画结束后卸载图片, 避免两个视图长期重复下载和保存图片副本. */
export function ResourceView({ active, children }: { active: boolean; children: ReactNode }): JSX.Element {
  const [rendered, setRendered] = useState(active);
  useEffect(() => {
    if (active) {
      setRendered(true);
      return;
    }
    const timeout = setTimeout(() => setRendered(false), 180);
    return () => clearTimeout(timeout);
  }, [active]);

  return (
    <div
      className="ema-resource-view"
      data-active={active}
      aria-hidden={!active}
      ref={element => { if (element) element.inert = !active; }}
    >
      <div className="min-h-0 overflow-hidden">{(active || rendered) && children}</div>
    </div>
  );
}
