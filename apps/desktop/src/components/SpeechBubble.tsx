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
import { useEffect, useRef, useState } from 'react';
import { tauriBridge } from '@ema-agent/desktop-ui';

const FADE_DELAY_MS = 4000;
const FADE_OUT_MS   = 600;

export function SpeechBubble(): React.JSX.Element | null {
  const [text, setText]       = useState('');
  const [visible, setVisible] = useState(false);
  const [fading, setFading]   = useState(false);
  const activeSession         = useRef<string | null>(null);
  const fadeTimer             = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearFade = (): void => {
      if (fadeTimer.current) { clearTimeout(fadeTimer.current); fadeTimer.current = null; }
    };

    const unlistenStart = tauriBridge.listen<{ sessionId: string }>(
      'speech:start',
      (e) => {
        clearFade();
        activeSession.current = e.payload.sessionId;
        setText('');
        setFading(false);
        setVisible(true);
      },
    );

    const unlistenDelta = tauriBridge.listen<{ sessionId: string; text: string }>(
      'speech:delta',
      (e) => {
        if (e.payload.sessionId !== activeSession.current) return;
        setText((prev) => prev + e.payload.text);
        setFading(false);
        setVisible(true);
      },
    );

    const unlistenEnd = tauriBridge.listen<{ sessionId: string }>(
      'speech:end',
      (e) => {
        if (e.payload.sessionId !== activeSession.current) return;
        fadeTimer.current = setTimeout(() => {
          setFading(true);
          setTimeout(() => { setVisible(false); setText(''); setFading(false); }, FADE_OUT_MS);
        }, FADE_DELAY_MS);
      },
    );

    return () => {
      clearFade();
      void unlistenStart.then((fn) => fn());
      void unlistenDelta.then((fn) => fn());
      void unlistenEnd.then((fn) => fn());
    };
  }, []);

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
          boxShadow:      'var(--ema-shadow-2), 0 0 16px rgba(255,214,230,0.07)',
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

      {/* Tail — border-trick triangle pointing down toward Ema's face */}
      <div
        style={{
          position:    'relative',
          left:        '50%',
          transform:   'translateX(-50%)',
          width:       0,
          height:      0,
          borderLeft:  '9px solid transparent',
          borderRight: '9px solid transparent',
          // Must match BUBBLE_BG — inline-only because no CSS var for alpha-blend
          borderTop:   `11px solid rgba(10, 8, 16, 0.90)`,
          marginTop:   -1,
        }}
      />
    </div>
  );
}
