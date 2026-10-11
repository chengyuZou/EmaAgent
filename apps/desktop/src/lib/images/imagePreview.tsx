import { memo, useEffect, useRef, useState, type JSX } from 'react';
import { useImageViewer, type ViewerImage } from './imageViewer.js';

export interface ImagePreviewProps {
  readonly src: string;
  readonly alt: string;
  readonly className?: string;
  readonly fit?: 'contain' | 'cover';
  readonly loadImage?: ViewerImage['loadImage'];
}

export const ImagePreview = memo(function ImagePreview(props: ImagePreviewProps): JSX.Element {
  return <PreviewImage key={props.src} {...props} />;
});

function PreviewImage({ src, alt, className, fit = 'contain', loadImage }: ImagePreviewProps): JSX.Element {
  const { openImage, closeImage } = useImageViewer();
  const imageRef = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');

  useEffect(() => () => closeImage(src), [closeImage, src]);

  return (
    <button
      type="button"
      className={`ema-image-preview ${className ?? ''}`}
      data-fit={fit}
      data-status={status}
      aria-label={`查看图片：${alt || '图片'}`}
      aria-busy={status === 'loading'}
      disabled={status !== 'loaded' && !loadImage}
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        const image = imageRef.current;
        openImage({
          src,
          alt,
          width: image?.naturalWidth,
          height: image?.naturalHeight,
          loadImage,
        });
      }}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('failed')}
      />
      {status === 'loading' && <span className="ema-image-preview-status" aria-hidden>加载中…</span>}
      {status === 'failed' && <span className="ema-image-preview-status">图片无法加载</span>}
    </button>
  );
}
