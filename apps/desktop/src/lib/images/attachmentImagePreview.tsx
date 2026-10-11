import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { sessionsApi } from '../../api/sessions.js';
import { ImagePreview } from './imagePreview.js';

export function AttachmentImagePreview({ sessionId, path, alt, className }: {
  readonly sessionId: string;
  readonly path: string;
  readonly alt: string;
  readonly className?: string;
}): JSX.Element {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<{ path: string; src: string }>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setPreview(undefined);
    setFailed(false);

    async function loadPreview(): Promise<void> {
      try {
        const response = await sessionsApi.readAttachmentContent(sessionId, path, true);
        const blob = await response.blob();
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setPreview({ path, src: objectUrl });
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    }

    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === 'undefined') {
      void loadPreview();
    } else {
      // 历史消息里可能有很多图片. 接近可见区域后才请求缩略图, 不一次读取整段历史的图片.
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer?.disconnect();
          void loadPreview();
        }
      }, { rootMargin: '200px' });
      if (containerRef.current) {
        observer.observe(containerRef.current);
      }
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [sessionId, path]);

  const loadImage = useCallback(async (): Promise<Blob> => {
    const response = await sessionsApi.readAttachmentContent(sessionId, path);
    return response.blob();
  }, [sessionId, path]);

  return (
    <span className="ema-attachment-image-preview" ref={containerRef}>
      {preview?.path === path ? (
        <ImagePreview
          src={preview.src}
          alt={alt}
          className={className}
          loadImage={loadImage}
        />
      ) : (
        <span className="ema-attachment-image-placeholder" role="status">
          {failed ? '图片无法加载' : '加载图片中…'}
        </span>
      )}
    </span>
  );
}
