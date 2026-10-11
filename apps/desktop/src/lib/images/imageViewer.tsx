import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import Lightbox, { type ZoomRef } from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';

const MAX_ZOOM_PIXEL_RATIO = 4;

export interface ViewerImage {
  readonly src: string;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
  /** 有独立缩略图时, 只在打开查看器后读取完整图片. 返回的 Blob 由查看器负责释放. */
  readonly loadImage?: () => Promise<Blob | string>;
}

interface ImageViewerActions {
  openImage(image: ViewerImage): void;
  closeImage(src?: string): void;
}

const ImageViewerContext = createContext<ImageViewerActions | null>(null);

export function useImageViewer(): ImageViewerActions {
  const actions = useContext(ImageViewerContext);
  if (!actions) {
    throw new Error('图片预览需要放在 ImageViewerProvider 内');
  }
  return actions;
}

export function ImageViewerProvider({ children, rootRef }: {
  readonly children: ReactNode;
  readonly rootRef: RefObject<HTMLElement>;
}): JSX.Element {
  const [image, setImage] = useState<ViewerImage | null>(null);
  const openImage = useCallback((next: ViewerImage) => setImage(next), []);
  const closeImage = useCallback((src?: string) => {
    setImage(current => {
      if (src === undefined || current?.src === src) {
        return null;
      }
      return current;
    });
  }, []);
  const actions = useMemo(() => ({ openImage, closeImage }), [openImage, closeImage]);

  return (
    <ImageViewerContext.Provider value={actions}>
      {children}
      {image && (
        <ImageViewer
          key={image.src}
          image={image}
          rootRef={rootRef}
          close={() => closeImage()}
        />
      )}
    </ImageViewerContext.Provider>
  );
}

function ImageViewer({ image, rootRef, close }: {
  readonly image: ViewerImage;
  readonly rootRef: RefObject<HTMLElement>;
  readonly close: () => void;
}): JSX.Element {
  const [loadedSrc, setLoadedSrc] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!image.loadImage) {
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    void image.loadImage().then(content => {
      if (cancelled) {
        return;
      }
      if (typeof content === 'string') {
        setLoadedSrc(content);
      } else {
        objectUrl = URL.createObjectURL(content);
        setLoadedSrc(objectUrl);
      }
    }).catch(() => {
      if (!cancelled) {
        setFailed(true);
      }
    });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [image]);

  const src = image.loadImage ? loadedSrc : image.src;
  const slides = useMemo(() => {
    if (!src) {
      return [];
    }
    if (image.loadImage) {
      return [{ src, alt: image.alt }];
    }
    return [{ src, alt: image.alt, width: image.width, height: image.height }];
  }, [src, image]);

  return (
    <Lightbox
      open
      close={close}
      slides={slides}
      plugins={[Zoom]}
      className="ema-image-viewer"
      portal={{ root: () => rootRef.current }}
      noScroll={{ disabled: true }}
      animation={{ fade: 0, zoom: 180 }}
      carousel={{ finite: true, preload: 0, padding: '56px', imageFit: 'contain' }}
      controller={{ closeOnEscape: true, closeOnBackdropClick: true }}
      zoom={{ scrollToZoom: true, maxZoomPixelRatio: MAX_ZOOM_PIXEL_RATIO }}
      labels={{
        Lightbox: '图片查看器',
        Close: '关闭图片',
        Slide: '图片',
        Carousel: '图片',
        'Photo gallery': '图片',
      }}
      styles={{ root: { position: 'absolute', zIndex: 'var(--ema-z-dialog)' } }}
      render={{
        buttonPrev: () => null,
        buttonNext: () => null,
        buttonZoom: zoom => <ZoomControls zoom={zoom} />,
        iconClose: () => <span className="i-lucide:x" aria-hidden />,
        iconError: () => (
          <span className="ema-image-viewer-error" role="status">
            图片无法加载，请关闭后重试。
          </span>
        ),
        controls: () => (
          <>
            <div className="ema-image-viewer-title" title={image.alt}>{image.alt}</div>
            {!src && (
              <div className="ema-image-viewer-status" role="status">
                {failed ? '图片无法加载，请关闭后重试。' : '加载图片中…'}
              </div>
            )}
          </>
        ),
      }}
    />
  );
}

function ZoomControls({ zoom }: { readonly zoom: ZoomRef }): JSX.Element {
  // maxZoom 按图片像素计算. 除去额外放大倍数后, 才是图片一个像素对应一个 CSS 像素的 100%.
  const originalZoom = zoom.maxZoom / MAX_ZOOM_PIXEL_RATIO;
  const percent = Math.round(zoom.zoom / originalZoom * 100);

  return (
    <div className="ema-image-viewer-zoom">
      <button 
        className="yarl__button" 
        type="button" 
        aria-label="缩小" 
        disabled={zoom.disabled || zoom.zoom <= 1} 
        onClick={zoom.zoomOut}
      >
        <span className="i-lucide:minus" aria-hidden />
      </button>
      <span className="ema-image-viewer-percent">{zoom.disabled ? '—' : `${percent}%`}</span>
      <button 
        className="yarl__button" 
        type="button" 
        aria-label="放大" 
        disabled={zoom.disabled || zoom.zoom >= zoom.maxZoom} 
        onClick={zoom.zoomIn}
      >
        <span className="i-lucide:plus" aria-hidden />
      </button>
      <button 
        className="yarl__button ema-image-viewer-text-button" 
        type="button" 
        disabled={zoom.disabled} 
        onClick={() => zoom.changeZoom(1, true, 0, 0)}
      >
        适配窗口
      </button>
      <button 
        className="yarl__button ema-image-viewer-text-button" 
        type="button" 
        disabled={zoom.disabled} 
        onClick={() => zoom.changeZoom(originalZoom, true, 0, 0)}
      >
        原始尺寸
      </button>
    </div>
  );
}
