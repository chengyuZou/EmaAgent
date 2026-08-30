/**
 * SpeechBubble — manga-style dialogue bubble in the pet window.
 *
 * Listens to Tauri IPC events relayed from the chat window:
 *   speech:start  — new turn started; clear and show bubble
 *   speech:delta  — streaming text delta; append to bubble
 *   speech:end    — turn finished; start fade-out timer
 *
 * Only tracks the most recently started session (mirrors ttsOwnerSessionId).
 * Positioned at the top of the transparent window so it floats above Ema.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { tauriBridge } from '../lib/tauri-bridge.js';

const FADE_DELAY_MS = 4000;
const FADE_OUT_MS   = 600;

/**
 * 气泡淡出生命周期控制器(F-030)。旧实现只持有"延迟淡出"定时器, 匿名
 * "淡出完成"定时器在新 turn 开始时无法取消, 到点把新回答清空。
 * 两个定时器都严格持有; 新 turn/新文本/重复结束/销毁统一取消;
 * 世代号兜底——已闭包的旧回调即使触发也不碰新消息。
 */
export interface FadeController {
  /** 排程完整淡出流程(延迟 → 淡出 → 隐藏清空); 重复调用先取消旧任务。 */
  scheduleFade(): void;
  /** 取消全部挂起任务并使旧回调失效。 */
  clear(): void;
}

export function createFadeController(opts: {
  fadeDelayMs: number;
  fadeOutMs: number;
  onFadeStart: () => void;
  onFadeDone: () => void;
}): FadeController {
  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let outTimer: ReturnType<typeof setTimeout> | null = null;
  let epoch = 0;

  const clear = (): void => {
    epoch += 1;
    if (delayTimer !== null) { clearTimeout(delayTimer); delayTimer = null; }
    if (outTimer !== null) { clearTimeout(outTimer); outTimer = null; }
  };

  const scheduleFade = (): void => {
    clear();
    const myEpoch = epoch;
    delayTimer = setTimeout(() => {
      delayTimer = null;
      if (myEpoch !== epoch) return;
      opts.onFadeStart();
      outTimer = setTimeout(() => {
        outTimer = null;
        if (myEpoch !== epoch) return;
        opts.onFadeDone();
      }, opts.fadeOutMs);
    }, opts.fadeDelayMs);
  };

  return { scheduleFade, clear };
}

export function SpeechBubble(): React.JSX.Element | null {
  const [text, setText]       = useState('');
  const [visible, setVisible] = useState(false);
  const [fading, setFading]   = useState(false);
  const activeSession         = useRef<string | null>(null);
  const fade                  = useMemo(
    () =>
      createFadeController({
        fadeDelayMs: FADE_DELAY_MS,
        fadeOutMs:   FADE_OUT_MS,
        onFadeStart: () => setFading(true),
        onFadeDone:  () => { setVisible(false); setText(''); setFading(false); },
      }),
    [],
  );

  useEffect(() => {
    const unlistenStart = tauriBridge.listenSpeechStarted(
      (sessionId) => {
        fade.clear();
        activeSession.current = sessionId;
        setText('');
        setFading(false);
        setVisible(true);
      },
    );

    const unlistenDelta = tauriBridge.listenSpeechDelta(
      (sessionId, text) => {
        if (sessionId !== activeSession.current) return;
        fade.clear();
        setText((prev) => prev + text);
        setFading(false);
        setVisible(true);
      },
    );

    const unlistenEnd = tauriBridge.listenSpeechEnded(
      (sessionId) => {
        if (sessionId !== activeSession.current) return;
        fade.scheduleFade();
      },
    );

    return () => {
      fade.clear();
      void unlistenStart.then((fn) => fn());
      void unlistenDelta.then((fn) => fn());
      void unlistenEnd.then((fn) => fn());
    };
  }, [fade]);

  if (!visible || !text) return null;

  return (
    <div
      style={{
        position:      'fixed',
        top:           14,
        left:          12,
        right:         12,
        zIndex:        50,
        pointerEvents: 'none',
        opacity:       fading ? 0 : 1,
        transition:    fading ? `opacity ${FADE_OUT_MS}ms ease` : 'none',
      }}
      // Entrance animation via CSS class (defined in desktop-ui/src/style.css)
      className={fading ? '' : 'ema-speech-in'}
    >
      {/* Bubble body */}
      <div
        style={{
          background:     'var(--ema-surface-0)',
          border:         '1px solid var(--ema-glow)',
          borderRadius:   'var(--ema-radius-lg)',
          padding:        '10px 14px',
          boxShadow:      'var(--ema-shadow-2), 0 0 16px color-mix(in srgb, var(--ema-pet-glow-bright) 12%, transparent)',
          backdropFilter: 'var(--ema-glass-base)',
          maxHeight:      210,
          overflow:       'hidden',
        }}
      >
        <p
          style={{
            margin:              0,
            fontSize:            13,
            lineHeight:          1.65,
            color:               'var(--ema-text-primary)',
            wordBreak:           'break-word',
            display:             '-webkit-box',
            WebkitLineClamp:     9,
            WebkitBoxOrient:     'vertical',
            overflow:            'hidden',
            whiteSpace:          'pre-wrap',
          }}
        >
          {text}
        </p>
      </div>

      {/* Tail — border-trick triangle pointing down toward Ema's face.
          颜色必须与气泡身一致,直接引用同一 token,永不漂移。 */}
      <div
        style={{
          position:    'relative',
          left:        '50%',
          transform:   'translateX(-50%)',
          width:       0,
          height:      0,
          borderLeft:  '9px solid transparent',
          borderRight: '9px solid transparent',
          borderTop:   '11px solid var(--ema-surface-0)',
          marginTop:   -1,
        }}
      />
    </div>
  );
}
