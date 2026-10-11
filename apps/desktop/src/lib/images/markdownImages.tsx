import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactNode,
} from 'react';
import { MarkdownRendererProvider, Tooltip } from '@ema-agent/ui';
import { filesApi } from '../../api/workspaces.js';
import { useImageViewer } from './imageViewer.js';

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|ico)$/i;

interface MarkdownImageFiles {
  readonly directory?: string;
  readonly onOpenFile?: (path: string) => void;
}

const MarkdownFiles = createContext<MarkdownImageFiles | null>(null);

function imageFilePath(href: string, directory?: string): string | undefined {
  if (/^(?:https?:|data:|blob:|\/\/)/i.test(href)) {
    return undefined;
  }
  let path = href;
  if (!/^file:/i.test(href)) {
    try {
      path = decodeURIComponent(href);
    } catch {
      path = href;
    }
  }
  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href);
      path = decodeURIComponent(url.pathname);
      if (url.hostname) {
        path = `//${url.hostname}${path}`;
      } else if (/^\/[a-z]:\//i.test(path)) {
        path = path.slice(1);
      }
    } catch {
      return undefined;
    }
  }
  if (!IMAGE_EXTENSION.test(path)) {
    return undefined;
  }
  const absolute = /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path);
  if (!absolute) {
    if (!directory || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
      return undefined;
    }
    path = `${directory.replace(/[\\/]+$/, '')}/${path}`;
  }
  return path.replace(/\\/g, '/');
}

function imageMarkdownUrl(url: string, key: string): string {
  const normalized = url.replace(/[\u0000-\u0020\u007f]/g, '');
  if (/^(?:https?:|mailto:|tel:|irc:|ircs:|xmpp:)/i.test(normalized)) {
    return url;
  }
  if (key === 'src' && /^(?:blob:|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(normalized)) {
    return url;
  }
  if (imageFilePath(url) !== undefined) {
    return url;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    return url;
  }
  return '';
}

async function readImageSource(path: string): Promise<string> {
  const content = await filesApi.readFile(path);
  if ('content' in content && content.encoding === 'base64') {
    return `data:${content.mimeType};base64,${content.content}`;
  }
  if ('tooLarge' in content) {
    throw new Error('图片超过文件预览的大小限制');
  }
  throw new Error('图片文件无法读取');
}

/**
 * 正文图片保持普通 img 的排版, 点击后打开 Viewer; 本地图片文字链接只通知文件侧栏打开文件.
 * 文件预览和 ReadTool 可覆盖 directory, 未提供的目录和文件打开操作从外层继承.
 */
export function MarkdownImages({ children, directory, onOpenFile }: {
  readonly children: ReactNode;
  /** 聊天使用会话工作目录, Markdown 文件预览使用该文件所在目录. */
  readonly directory?: string;
  /** 只负责打开文件标签, 读取和展示由文件侧栏完成. */
  readonly onOpenFile?: (path: string) => void;
}): JSX.Element {
  const parentFiles = useContext(MarkdownFiles);
  const parentDirectory = parentFiles?.directory;
  const openFile = onOpenFile ?? parentFiles?.onOpenFile;
  let imageDirectory = directory ?? parentDirectory;
  if (directory && parentDirectory && !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(directory)) {
    imageDirectory = `${parentDirectory}/${directory}`;
  }
  const components = useMemo<ComponentProps<typeof MarkdownRendererProvider>['components']>(() => ({
    img({ node: _node, src, alt, ...props }) {
      if (!src) {
        return null;
      }
      const path = imageFilePath(src, imageDirectory);
      if (path) {
        return <FileImage key={path} {...props} path={path} alt={alt ?? '图片'} />;
      }
      return <InlineImage key={src} {...props} src={src} alt={alt ?? '图片'} />;
    },
    a({ node, href, title, children: linkText, ...props }) {
      // 图片自己打开 Viewer, 不让外层链接同时触发文件打开或网页跳转.
      if (node?.children.some(child => child.type === 'element' && child.tagName === 'img')) {
        return <>{linkText}</>;
      }
      const path = href ? imageFilePath(href, imageDirectory) : undefined;
      const external = href !== undefined && /^https?:\/\//i.test(href);
      return (
        <Tooltip
          variant="card"
          content={href && (
            <>
              {title && <div className="mb-1 font-medium">{title}</div>}
              <div>{href}</div>
            </>
          )}
        >
          <a
            {...props}
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
            onClick={event => {
              if (!path || !openFile) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              openFile(path);
            }}
          >
            {linkText}
          </a>
        </Tooltip>
      );
    },
  }), [imageDirectory, openFile]);
  const files = useMemo(() => ({
    directory: imageDirectory,
    onOpenFile: openFile,
  }), [imageDirectory, openFile]);

  return (
    <MarkdownFiles.Provider value={files}>
      <MarkdownRendererProvider components={components} urlTransform={imageMarkdownUrl}>
        {children}
      </MarkdownRendererProvider>
    </MarkdownFiles.Provider>
  );
}

type InlineImageProps = Omit<ComponentPropsWithoutRef<'img'>, 'src' | 'alt'> & {
  readonly src: string;
  readonly alt: string;
};

function InlineImage({ src, alt, className, ...props }: InlineImageProps): JSX.Element {
  const { openImage, closeImage } = useImageViewer();
  useEffect(() => () => closeImage(src), [closeImage, src]);

  function openViewer(image: HTMLImageElement): void {
    openImage({
      src,
      alt,
      width: image.naturalWidth || undefined,
      height: image.naturalHeight || undefined,
    });
  }

  return (
    <img
      {...props}
      src={src}
      alt={alt}
      className={`ema-markdown-image${className ? ` ${className}` : ''}`}
      loading="lazy"
      decoding="async"
      draggable={false}
      role="button"
      tabIndex={0}
      aria-label={`查看图片：${alt || '图片'}`}
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        openViewer(event.currentTarget);
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openViewer(event.currentTarget);
      }}
    />
  );
}

function FileImage({ path, alt, ...props }: Omit<InlineImageProps, 'src'> & {
  readonly path: string;
}): JSX.Element {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    // 只有正文中的本地图片需要在这里读取. 得到的地址也交给 Viewer, 点开时不重复读取文件.
    void readImageSource(path).then(src => {
      if (!cancelled) {
        setSrc(src);
      }
    }).catch(error => {
      if (!cancelled) {
        setError(error instanceof Error ? error.message : '图片无法加载');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (src) {
    return <InlineImage {...props} src={src} alt={alt} />;
  }
  return <span className="ema-markdown-image-status" role="status">{error ?? '加载图片中…'}</span>;
}
