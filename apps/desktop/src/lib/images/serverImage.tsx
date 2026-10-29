// 需要鉴权的服务端图片:<img> 直链会被 401,先 fetch 成 blob 再转 objectURL
import { useEffect, useState, type JSX } from 'react';
import { ImagePlaceholder } from './imagePlaceholder.js';
import { fetchServerObjectUrl } from '../../api/serverFileUrl.js';

export function ServerImage({
  path, alt, className, contentUpdatedAt, onLoad, onMissing,
}: {
  path: string;
  alt: string;
  className?: string;
  contentUpdatedAt?: number;
  onLoad?: () => void;
  onMissing?: () => void;
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let disposed = false;
    setUrl(null);
    setMissing(false);
    void fetchServerObjectUrl(path).then(async result => {
      if (disposed) {
        if (result) URL.revokeObjectURL(result);
        return;
      }
      if (result === null) {
        setMissing(true);
        onMissing?.();
        return;
      }
      objectUrl = result;
      // 每张图片独立解码; 等待期间保留占位框, 不影响标签和其他卡片.
      const image = new Image();
      image.decoding = 'async';
      image.src = result;
      try {
        await image.decode();
        if (!disposed) setUrl(result);
      } catch {
        if (!disposed) {
          setMissing(true);
          onMissing?.();
        }
      }
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, contentUpdatedAt]);

  if (missing) {
    // Live2D 封面缺失时由卡片提供重新生成按钮.
    return onMissing ? null : <ImagePlaceholder failed className={className} />;
  }
  if (!url) return <ImagePlaceholder className={className} />;
  // 高清封面异步解码, 不让首次绘制等待整张图片解码完成而阻塞标签切换.
  return (
    <img
      src={url}
      alt={alt}
      className={`ema-image-reveal ${className ?? ''}`}
      decoding="async"
      onLoad={onLoad}
    />
  );
}
