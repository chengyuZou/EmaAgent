import { useEffect, useRef, useState } from 'react';
import { tauriBridge } from '../lib/tauri-bridge.js';
import type { WallpaperSettings } from '@ema-agent/server/settings/wallpaperSetting.js';
import { DEFAULT_WALLPAPER_SETTINGS, WALLPAPER_SETTING_KEYS } from '@ema-agent/server/settings/wallpaperCatalog.js';
import { settingsApi } from '../api/settings.js';
import { subscribeSystemEvent } from '../lib/system-event-dispatcher.js';

const FADE_DELAY_MS = 3000;
const FADE_OUT_MS   = 600;
const MAX_DIALOGUE_TEXT_LENGTH = 500;

interface DialogueOwner {
  readonly sessionId: string;
  readonly turnId: string;
}

function trimDialogueText(text: string): string {
  return text.length > MAX_DIALOGUE_TEXT_LENGTH
    ? text.slice(-MAX_DIALOGUE_TEXT_LENGTH)
    : text;
}

export function SpeechBubble(): React.JSX.Element | null {

  const [wallpaper, setWallpaper] = useState<Pick<WallpaperSettings, 'enabled' | 'materialMode'>>({
    enabled: DEFAULT_WALLPAPER_SETTINGS.enabled,
    materialMode: DEFAULT_WALLPAPER_SETTINGS.materialMode,
  });
  
  const materialClass = wallpaper.enabled ? `ema-stage-${wallpaper.materialMode}` : '';
  const [text, setText]       = useState('');
  const [visible, setVisible] = useState(false);
  const [fading, setFading]   = useState(false);
  const activeDialogue        = useRef<DialogueOwner | null>(null);
  const textRef               = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let sequence = 0;

    async function refresh(): Promise<void> {
      const requestSequence = ++sequence;
      try {
        const response = await settingsApi.getValue(WALLPAPER_SETTING_KEYS.settings);
        if (disposed || requestSequence !== sequence) return;
        const value = response.value as WallpaperSettings;
        setWallpaper({ enabled: value.enabled, materialMode: value.materialMode });
      } catch (error) {
        console.warn('[speech-bubble] 读取浮层外观设置失败:', error);
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

    // 新正文必须同时取消静默计时和淡出后的移除, 避免旧任务清空新文字.
    const clearFade = (): void => {
      clearTimeout(delayTimer);
      clearTimeout(outTimer);
      delayTimer = undefined;
      outTimer = undefined;
    };

    const unlistenDelta = tauriBridge.listenDialogueDelta(
      (sessionId, turnId, delta) => {
        clearFade();
        const active = activeDialogue.current;
        if (active?.sessionId !== sessionId || active.turnId !== turnId) {
          activeDialogue.current = { sessionId, turnId };
          setText(trimDialogueText(delta));
        } else {
          setText(current => trimDialogueText(current + delta));
        }
        setFading(false);
        setVisible(true);
        // 静默只按正文更新计算, 不等待 Turn 或语音播放结束.
        delayTimer = setTimeout(() => {
          delayTimer = undefined;
          setFading(true);
          outTimer = setTimeout(() => {
            outTimer = undefined;
            setVisible(false);
            setText('');
            setFading(false);
          }, FADE_OUT_MS);
        }, FADE_DELAY_MS);
      },
    );

    const unlistenEnd = tauriBridge.listenDialogueEnded((sessionId, turnId) => {
      const active = activeDialogue.current;
      if (active?.sessionId !== sessionId || active.turnId !== turnId) return;
      // 结束只清理归属, 不重置最后 Delta 启动的静默计时.
      activeDialogue.current = null;
    });

    return () => {
      clearFade();
      void unlistenDelta.then((fn) => fn());
      void unlistenEnd.then((fn) => fn());
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
          {text}
        </p>
      </div>

      <div className="ema-stage-surface ema-stage-speech-tail" aria-hidden />
    </div>
  );
}
