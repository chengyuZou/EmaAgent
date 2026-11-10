import { wallpaperSetting } from '@ema-agent/server/settings';
import { useEffect, useRef, useState } from 'react';
import type { CaptionState } from '../lib/tauri/types.js';
import { tauriBridge } from '../lib/tauri/tauriBridge.js';
import type { WallpaperSettings } from '@ema-agent/server/settings/wallpaperSetting.js';
import { DEFAULT_WALLPAPER_SETTINGS } from '@ema-agent/server/settings/wallpaperCatalog.js';
import { settingsApi } from '../api/settings.js';
import { subscribeSystemEvent } from '../lib/events/systemEventDispatcher.js';

const FADE_DELAY_MS = 3000;
const FADE_OUT_MS = 600;

export function SpeechCaption(): React.JSX.Element | null {
  const [wallpaper, setWallpaper] = useState<Pick<WallpaperSettings, 'enabled' | 'materialMode'>>({
    enabled: DEFAULT_WALLPAPER_SETTINGS.enabled,
    materialMode: DEFAULT_WALLPAPER_SETTINGS.materialMode,
  });

  const materialClass = wallpaper.enabled ? `ema-stage-${wallpaper.materialMode}` : '';
  const [caption, setCaption] = useState<Exclude<CaptionState, { kind: 'hidden' }> | null>(null);
  const text = caption?.text ?? '';
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const textRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let sequence = 0;

    async function refresh(): Promise<void> {
      const requestSequence = ++sequence;
      try {
        const response = await settingsApi.getValue(wallpaperSetting);
        if (disposed || requestSequence !== sequence) return;
        const value = response.value;
        setWallpaper({ enabled: value.enabled, materialMode: value.materialMode });
      } catch (error) {
        console.warn('[speech-caption] 读取浮层外观设置失败:', error);
      }
    }

    const stop = subscribeSystemEvent((event) => {
      if (event.type === 'settings_changed') void refresh();
    });
    void refresh();
    return () => {
      disposed = true;
      stop();
    };
  }, []);

  useEffect(() => {
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let outTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let lastRevision = -1;

    const clearFade = (): void => {
      clearTimeout(delayTimer);
      clearTimeout(outTimer);
    };
    const fadeOut = (): void => {
      setFading(true);
      outTimer = setTimeout(() => {
        setVisible(false);
        setCaption(null);
        setFading(false);
      }, FADE_OUT_MS);
    };

    const subscription = tauriBridge.listenCaptionState(state => {
      if (disposed || state.revision <= lastRevision) return;
      lastRevision = state.revision;
      clearFade();
      if (state.kind === 'hidden') {
        fadeOut();
        return;
      }
      setCaption(state);
      setVisible(true);
      setFading(false);
      // 语音字幕保持到实际播放结束. 纯文字沿用最后一次正文更新后的短暂阅读时间.
      if (state.kind === 'text') delayTimer = setTimeout(fadeOut, FADE_DELAY_MS);
    });
    // 先完成监听注册, 再请求当前字幕, 防止视图晚挂载时漏掉首条状态.
    void subscription.then(unlisten => {
      if (disposed) unlisten();
      else void tauriBridge.requestCaptionState();
    });

    return () => {
      disposed = true;
      clearFade();
      void subscription.then(unlisten => unlisten());
    };
  }, []);

  useEffect(() => {
    const element = textRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [text]);

  if (!visible || !text) return null;

  return (
    <div
      className={`ema-stage-speech-bubble ${materialClass} ${fading ? '' : 'ema-speech-in'}`}
      data-fading={fading}
      style={{ transitionDuration: `${FADE_OUT_MS}ms` }}
    >
      <div className="ema-stage-surface ema-stage-speech-body">
        <p
          ref={textRef}
          className="ema-speech-bubble-text"
        >
          {caption?.kind === 'speech' ? (
            <span key={caption.audioId + ':' + caption.segmentIndex} aria-label={text}>
              {Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment)
                .map((character, index) => (
                  <span
                    key={index}
                    aria-hidden
                    className="ema-caption-character"
                    style={{
                      // 固定间隔的显字动画, 没有按这一段的实际音频时长分配每个字的时间.
                      // playing 仅控制缓冲时暂停和恢复动画, 当前显示哪一段由播放器选择.
                      animationDelay: `${index * 15}ms`,
                      animationPlayState: caption.playing ? 'running' : 'paused',
                    }}
                  >
                    {character}
                  </span>
                ))}
            </span>
          ) : text}
        </p>
      </div>

      <div className="ema-stage-surface ema-stage-speech-tail" aria-hidden />
    </div>
  );
}
