import { useEffect, useRef, useState, type JSX } from 'react';
import type { WallpaperSettings } from '@ema-agent/server/settings/wallpaperSetting.js';
import {
  DEFAULT_WALLPAPER_IMAGE_PARAMS,
  WALLPAPER_SETTING_KEYS,
  type WallpaperWindowTarget,
} from '@ema-agent/server/settings/wallpaperCatalog.js';
import { settingsApi } from '../api/settings.js';
import { wallpaperApi } from '../api/wallpaper.js';
import { subscribeSystemEvent } from '../lib/system-event-dispatcher.js';
import { fetchServerObjectUrl } from '../lib/serverFileUrl.js';

interface WallpaperFrame {
  readonly id: number;
  readonly name: string;
  readonly url: string;
  readonly opacity: number;
  readonly blur: number;
  readonly outgoing: boolean;
}

export function WallpaperLayer({ target }: { target: WallpaperWindowTarget }): JSX.Element {
  const [settings, setSettings] = useState<WallpaperSettings | null>(null);
  const [frames, setFrames] = useState<WallpaperFrame[]>([]);
  const framesRef = useRef<WallpaperFrame[]>([]);
  const nextFrameId = useRef(0);

  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const retirementTimers = new Set<ReturnType<typeof setTimeout>>();

    function replaceFrames(next: WallpaperFrame[]): void {
      framesRef.current = next;
      setFrames(next);
    }

    function retireActiveFrames(): void {
      const active = framesRef.current.filter(frame => !frame.outgoing);
      if (active.length === 0) return;
      replaceFrames(framesRef.current.map(frame => frame.outgoing ? frame : { ...frame, outgoing: true }));
      for (const frame of active) {
        const timer = setTimeout(() => {
          retirementTimers.delete(timer);
          URL.revokeObjectURL(frame.url);
          replaceFrames(framesRef.current.filter(item => item.id !== frame.id));
        }, 340);
        retirementTimers.add(timer);
      }
    }

    function showImage(name: string, url: string | null, value: WallpaperSettings): void {
      retireActiveFrames();
      if (!url) return;
      const params = value.images[name] ?? DEFAULT_WALLPAPER_IMAGE_PARAMS;
      replaceFrames([
        ...framesRef.current,
        {
          id: ++nextFrameId.current,
          name,
          url,
          opacity: params.opacity,
          blur: params.blur,
          outgoing: false,
        },
      ]);
    }

    async function refresh(): Promise<void> {
      const currentSequence = ++sequence;
      try {
        const response = await settingsApi.getValue(WALLPAPER_SETTING_KEYS[target]);
        if (disposed || currentSequence !== sequence) return;
        let value = response.value as WallpaperSettings;
        if (!value.enabled || !value.activeImage) {
          setSettings(value);
          retireActiveFrames();
          return;
        }
        if (framesRef.current.some(frame => !frame.outgoing && frame.name === value.activeImage)) {
          setSettings(value);
          return;
        }

        let url = await fetchServerObjectUrl(wallpaperApi.imagePath(target, value.activeImage));
        if (!url) {
          const catalog = await wallpaperApi.listImages(target);
          if (catalog.items.some(item => item.name === value.activeImage)) return;
          const nextName = catalog.items.find(item => item.name > value.activeImage)?.name
            ?? catalog.items[0]?.name
            ?? '';
          value = { ...value, activeImage: nextName };
          await settingsApi.putValue(WALLPAPER_SETTING_KEYS[target], value);
          if (nextName) url = await fetchServerObjectUrl(wallpaperApi.imagePath(target, nextName));
        }
        if (url) {
          try {
            const image = new Image();
            image.src = url;
            await image.decode();
          } catch (error) {
            URL.revokeObjectURL(url);
            throw error;
          }
        }
        if (disposed || currentSequence !== sequence) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        setSettings(value);
        showImage(value.activeImage, url, value);
      } catch (error) {
        console.warn('[wallpaper] 加载窗口壁纸失败:', error);
      }
    }

    void refresh();
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type !== 'settings_changed') return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void refresh(); }, 80);
    });
    return () => {
      disposed = true;
      sequence += 1;
      clearTimeout(refreshTimer);
      unsubscribe();
      for (const timer of retirementTimers) clearTimeout(timer);
      for (const frame of framesRef.current) URL.revokeObjectURL(frame.url);
      framesRef.current = [];
    };
  }, [target]);

  const hasImage = frames.length > 0;
  return (
    <div
      className="ema-wallpaper-layer pointer-events-none absolute inset-0 z-0 overflow-hidden"
      data-visible={hasImage || undefined}
      data-acrylic={(hasImage && settings?.acrylicEnabled) || undefined}
      aria-hidden
    >
      {frames.map(frame => {
        const params = !frame.outgoing && frame.name === settings?.activeImage
          ? settings.images[frame.name] ?? DEFAULT_WALLPAPER_IMAGE_PARAMS
          : frame;
        return (
          <div
            key={frame.id}
            className="ema-wallpaper-frame absolute inset-0"
            data-state={frame.outgoing ? 'outgoing' : 'active'}
          >
            <img
              src={frame.url}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              style={{
                opacity: params.opacity,
                filter: `blur(${params.blur}px)`,
                transform: `scale(${1 + params.blur / 100})`,
              }}
              draggable={false}
            />
          </div>
        );
      })}
    </div>
  );
}
