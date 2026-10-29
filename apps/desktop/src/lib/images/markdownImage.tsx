import { useEffect, useState, type ComponentPropsWithoutRef, type JSX } from 'react';
import { filesApi } from '../../api/workspaces.js';
import { ImagePlaceholder } from './imagePlaceholder.js';
import { useImageViewer } from './imageViewer.js';

type InlineImageProps = Omit<ComponentPropsWithoutRef<'img'>, 'src' | 'alt'> & {
  readonly src: string;
  readonly alt: string;
};

export type MarkdownImageProps = Omit<InlineImageProps, 'src'> & ({
  readonly src: string;
  readonly filePath?: never;
} | {
  readonly filePath: string;
  readonly src?: never;
});

/** 保留正文图片的原有排版, 仅接入点击查看; 不使用附件的缩略图卡片布局. */
export function MarkdownImage(props: MarkdownImageProps): JSX.Element {
  if (props.filePath !== undefined) {
    return <FileImage key={props.filePath} {...props} path={props.filePath} />;
  }
  return <InlineImage key={props.src} {...props} src={props.src} />;
}

function InlineImage({ src, alt, className, ...props }: InlineImageProps): JSX.Element {
  const { openImage, closeImage } = useImageViewer();
  const [failed, setFailed] = useState(false);
  useEffect(() => () => closeImage(src), [closeImage, src]);

  function openViewer(image: HTMLImageElement): void {
    openImage({
      src,
      alt,
      width: image.naturalWidth || undefined,
      height: image.naturalHeight || undefined,
    });
  }

  if (failed) {
    return <ImagePlaceholder failed className="ema-markdown-image-placeholder" />;
  }

  return (
    <img
      {...props}
      src={src}
      alt={alt}
      className={`ema-markdown-image${className ? ` ${className}` : ''}`}
      onError={() => setFailed(true)}
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

function FileImage({ path, filePath: _filePath, ...props }: Omit<MarkdownImageProps, 'src'> & {
  readonly path: string;
}): JSX.Element {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    // 得到的图片地址也交给 Viewer, 点开时不重复读取文件.
    void filesApi.readFile(path).then(content => {
      if ('content' in content && content.encoding === 'base64') {
        if (!cancelled) {
          setSrc(`data:${content.mimeType};base64,${content.content}`);
        }
        return;
      }
      if ('tooLarge' in content) {
        throw new Error('图片超过文件预览的大小限制');
      }
      throw new Error('图片文件无法读取');
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
    const sticker = path.replaceAll('\\', '/').includes('/stickers/');
    return (
      <InlineImage
        {...props}
        src={src}
        className={(props.className ?? '') + (sticker ? ' ema-markdown-sticker' : '')}
      />
    );
  }
  return <ImagePlaceholder failed={!!error} className="ema-markdown-image-placeholder" />;
}
