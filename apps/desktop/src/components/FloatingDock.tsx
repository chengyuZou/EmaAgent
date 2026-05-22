import { useState } from 'react';
import { invokeWindow } from '../api/window-control.js';

// ── Floating dock ───────────────────────────────────────────────────────────
//
// Vertical column of circular icon buttons. Buttons:
//   - chat       → open chat sub-window (mode selector lives inside it)
//   - voice      → open voice-refs management
//   - settings   → open settings
//   - expression → cycle through character expressions (fun toy)
//   - pin        → toggle alwaysOnTop
//   - passthrough → toggle ignore_cursor_events (click-through)
//   - quit       → exit app
//
// `visible` is driven by hover state in App.tsx — dock fades in when the
// cursor is over the window, out when it leaves. The fade is opacity +
// transform so the buttons don't grab clicks while invisible.

interface DockAction {
  id:       string;
  label:    string;
  icon:     string;
  onClick:  () => void;
  active?:  boolean;
  danger?:  boolean;
}

export interface FloatingDockProps {
  /** Show / hide based on cursor presence in the main window. */
  visible: boolean;
}

export function FloatingDock({ visible }: FloatingDockProps): React.JSX.Element {
  const [pinned,      setPinned]      = useState(true);
  const [passthrough, setPassthrough] = useState(false);

  const togglePin = async (): Promise<void> => {
    const next = !pinned;
    setPinned(next);
    await invokeWindow.setAlwaysOnTop(next);
  };

  const togglePassthrough = async (): Promise<void> => {
    const next = !passthrough;
    setPassthrough(next);
    await invokeWindow.setPassthrough(next);
  };

  const openWindow = (name: string): void => {
    void invokeWindow.openWindow(name);
  };

  const cycleExpression = (): void => {
    // Pulled live from Live2D stage in a later round; for now log and let the
    // user notice nothing happened yet.
    console.log('[dock] expression cycle — pending Live2D expression API');
  };

  const actions: DockAction[] = [
    { id: 'chat',         label: '聊天',        icon: '💬', onClick: () => openWindow('chat') },
    { id: 'voice',        label: '角色音色',    icon: '🎤', onClick: () => openWindow('voice') },
    { id: 'settings',     label: '设置',        icon: '⚙️', onClick: () => openWindow('settings') },
    { id: 'expression',   label: '切换表情',    icon: '😊', onClick: cycleExpression },
    { id: 'pin',          label: pinned ? '取消置顶' : '置顶',
                          icon: pinned ? '📌' : '📍',
                          onClick: () => { void togglePin(); },
                          active: pinned },
    { id: 'passthrough',  label: passthrough ? '关闭点击穿透' : '点击穿透',
                          icon: '👻',
                          onClick: () => { void togglePassthrough(); },
                          active: passthrough },
    { id: 'quit',         label: '退出',        icon: '✕',
                          onClick: () => { void invokeWindow.quit(); },
                          danger: true },
  ];

  return (
    <div
      style={{
        ...dockStyle,
        opacity:        visible ? 1 : 0,
        pointerEvents:  visible ? 'auto' : 'none',
        transform:      `translateY(-50%) translateX(${visible ? 0 : 24}px)`,
      }}
      // Prevent the window's drag region from hijacking dock clicks
      data-tauri-drag-region={false}
    >
      {actions.map((action) => (
        <DockButton key={action.id} {...action} />
      ))}
    </div>
  );
}

function DockButton({ icon, label, onClick, active, danger }: DockAction): React.JSX.Element {
  const [hover,   setHover]   = useState(false);
  const [pressed, setPressed] = useState(false);

  const computed: React.CSSProperties = {
    ...buttonStyle,
    ...(active  ? buttonActiveStyle  : {}),
    ...(hover   ? buttonHoverStyle   : {}),
    ...(pressed ? buttonPressedStyle : {}),
    ...(danger && hover ? buttonDangerHoverStyle : {}),
  };

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPressed(false); }}
      onMouseDown={()  => setPressed(true)}
      onMouseUp={()    => setPressed(false)}
      style={computed}
      title={label}
    >
      <span style={iconStyle}>{icon}</span>
      {hover && <span style={tooltipStyle}>{label}</span>}
    </button>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const DOCK_BG    = 'rgba(20, 22, 30, 0.62)';
const DOCK_BORDER = 'rgba(255, 214, 230, 0.18)';   // hint of Ema pink-white
const BTN_BG     = 'rgba(40, 42, 52, 0.55)';
const BTN_HOVER  = 'rgba(255, 214, 230, 0.22)';
const BTN_ACTIVE = 'rgba(255, 214, 230, 0.45)';

const dockStyle: React.CSSProperties = {
  position:       'fixed',
  right:          12,
  top:            '50%',
  display:        'flex',
  flexDirection:  'column',
  gap:            8,
  padding:        '10px 8px',
  background:     DOCK_BG,
  border:         `1px solid ${DOCK_BORDER}`,
  borderRadius:   24,
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  boxShadow:      '0 4px 24px rgba(0, 0, 0, 0.35)',
  zIndex:         100,
  transition:     'opacity 0.22s ease-out, transform 0.22s ease-out',
};

const buttonStyle: React.CSSProperties = {
  position:       'relative',
  width:          36,
  height:         36,
  borderRadius:   '50%',
  border:         '1px solid rgba(255, 255, 255, 0.08)',
  background:     BTN_BG,
  color:          '#f5f5f5',
  cursor:         'pointer',
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'center',
  padding:        0,
  transition:     'background 0.15s ease, transform 0.1s ease, border-color 0.15s ease',
};

const buttonHoverStyle: React.CSSProperties = {
  background:   BTN_HOVER,
  transform:    'scale(1.08)',
  borderColor:  'rgba(255, 214, 230, 0.4)',
};

const buttonActiveStyle: React.CSSProperties = {
  background:   BTN_ACTIVE,
  borderColor:  'rgba(255, 214, 230, 0.7)',
  boxShadow:    '0 0 12px rgba(255, 214, 230, 0.45)',
};

const buttonPressedStyle: React.CSSProperties = {
  transform:    'scale(0.92)',
};

const buttonDangerHoverStyle: React.CSSProperties = {
  background:   'rgba(220, 60, 60, 0.7)',
  borderColor:  'rgba(255, 100, 100, 0.7)',
};

const iconStyle: React.CSSProperties = {
  fontSize:     15,
  lineHeight:   1,
  pointerEvents: 'none',
};

const tooltipStyle: React.CSSProperties = {
  position:     'absolute',
  right:        44,
  top:          '50%',
  transform:    'translateY(-50%)',
  whiteSpace:   'nowrap',
  fontSize:     12,
  padding:      '4px 10px',
  background:   'rgba(20, 22, 30, 0.95)',
  border:       '1px solid rgba(255, 214, 230, 0.2)',
  borderRadius: 6,
  pointerEvents: 'none',
  color:        '#f5f5f5',
};
