// 需要鉴权的服务端图片:<img> 直链会被 401,先 fetch 成 blob 再转 objectURL。
import { useEffect, useState, type JSX } from 'react';
import { fetchServerObjectUrl } from '../lib/serverFileUrl.js';

export function ServerImage({
  path, alt, className, onMissing,
}: {
  path: string;
  alt: string;
  className?: string;
  onMissing?: () => void;
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let disposed = false;
    setUrl(null);
    setMissing(false);
    void fetchServerObjectUrl(path).then(result => {
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
      setUrl(result);
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (missing || !url) return null;
  return <img src={url} alt={alt} className={className} />;
}
