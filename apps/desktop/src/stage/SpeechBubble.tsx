/**
 * SpeechBubble — manga-style dialogue bubble in the pet window.
 *
 * Chat 窗口已经选好唯一的 Presentation owner. 这里只接收它转发的
 * Dialogue 文本和结束事件, 不再自己根据最后一条消息抢 owner.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { tauriBridge } from '../lib/tauri-bridge.js';

const FADE_DELAY_MS = 4000;
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
  const activeDialogue        = useRef<DialogueOwner | null>(null);
  const textRef               = useRef<HTMLParagraphElement | null>(null);
  const fade                  = useMemo(
    () =>
      createFadeController({
        fadeDelayMs: FADE_DELAY_MS,
        fadeOutMs:   FADE_OUT_MS,
        onFadeStart: () => setFading(true),
        onFadeDone:  () => {
          activeDialogue.current = null;
          setVisible(false);
          setText('');
          setFading(false);
        },
      }),
    [],
  );

  useEffect(() => {
    const unlistenDelta = tauriBridge.listenDialogueDelta(
      (sessionId, turnId, delta) => {
        fade.clear();
        const active = activeDialogue.current;
        if (active?.sessionId !== sessionId || active.turnId !== turnId) {
          activeDialogue.current = { sessionId, turnId };
          setText(trimDialogueText(delta));
        } else {
          setText(current => trimDialogueText(current + delta));
        }
        setFading(false);
        setVisible(true);
      },
    );

    const unlistenEnd = tauriBridge.listenDialogueEnded(
      (sessionId, turnId) => {
        const active = activeDialogue.current;
        if (active?.sessionId !== sessionId || active.turnId !== turnId) return;
        fade.scheduleFade();
      },
    );

    return () => {
      fade.clear();
      void unlistenDelta.then((fn) => fn());
      void unlistenEnd.then((fn) => fn());
    };
  }, [fade]);

  useEffect(() => {
    const element = textRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [text]);

  if (!visible || !text) return null;

  return (
    <div
      style={{
        position:      'fixed',
        top:           20,
        right:         16,
        width:         'min(240px, calc(100vw - 32px))',
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
          padding:        '12px 16px',
          boxShadow:      'var(--ema-shadow-2), 0 0 16px color-mix(in srgb, var(--ema-pet-glow-bright) 12%, transparent)',
          backdropFilter: 'var(--ema-glass-base)',
          maxHeight:      80,
          overflow:       'hidden',
        }}
      >
        <p
          ref={textRef}
          className="ema-speech-bubble-text"
          style={{
            margin:              0,
            fontSize:            13,
            lineHeight:          1.65,
            color:               'var(--ema-text-primary)',
            wordBreak:           'break-word',
            maxHeight:            60,
            overflowY:            'auto',
            scrollbarWidth:       'none',
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
          left:        '72%',
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
