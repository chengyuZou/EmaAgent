import { useState } from 'react';
import { invokeWindow } from '../api/window-control.js';

// ── Floating dock ───────────────────────────────────────────────────────────
//
// Vertical column of circular icon buttons stuck to the right edge of the
// main window. Each opens a feature: chat / settings / workspace / voice.
// Plus utility toggles: pin (always-on-top) and passthrough (click-through).
// Plus a close button (quit app — for V1; in V1.5 this hides to tray).
//
// Open-window commands (chat / settings / workspace / voice) emit a console
// log for now — actual multi-window logic lives in P1-1c.

interface DockAction {
  id:       string;
  label:    string;
  icon:     string;       // emoji placeholder; replace with SVG icons later
  onClick:  () => void;
  active?:  boolean;
}

export interface FloatingDockProps {
  /** Hide the dock entirely (used when passthrough is on). */
  hidden?: boolean;
}

export function FloatingDock({ hidden }: FloatingDockProps): React.JSX.Element | null {
  const [pinned,      setPinned]      = useState(true);
  const [passthrough, setPassthrough] = useState(false);

  if (hidden) return null;

  const togglePin = async (): Promise<void> => {
    const next = !pinned;
    setPinned(next);
    await invokeWindow.setAlwaysOnTop(next);
  };

  const togglePassthrough = async (): Promise<void> => {
    const next = !passthrough;
    setPassthrough(next);
    await invokeWindow.setPassthrough(next);
    // Once passthrough is on, the user can't click any UI. They need a
    // keyboard shortcut OR system tray to toggle back. V1 limitation.
    if (next) {
      console.warn('Passthrough on — Ctrl+Shift+E to re-enable (not wired yet)');
    }
  };

  const openWindow = (name: string): void => {
    // P1-1c will replace this with invoke('open_window', { name })
    console.log(`[dock] open ${name} window — pending P1-1c`);
  };

  const actions: DockAction[] = [
    { id: 'chat',       label: '聊天',     icon: '💬', onClick: () => openWindow('chat') },
    { id: 'settings',   label: '设置',     icon: '⚙️', onClick: () => openWindow('settings') },
    { id: 'workspace',  label: 'Agent',   icon: '🛠️', onClick: () => openWindow('workspace') },
    { id: 'voice',      label: '角色音色', icon: '🎤', onClick: () => openWindow('voice') },
    { id: 'pin',        label: pinned ? '取消置顶' : '置顶',
                        icon: pinned ? '📍' : '📌', onClick: () => { void togglePin(); }, active: pinned },
    { id: 'passthrough', label: '点击穿透', icon: '👻',
                        onClick: () => { void togglePassthrough(); }, active: passthrough },
    { id: 'quit',       label: '退出',     icon: '✖️', onClick: () => { void invokeWindow.quit(); } },
  ];

  return (
    <div style={dockStyle}>
      {actions.map((action) => (
        <DockButton key={action.id} {...action} />
      ))}
    </div>
  );
}

function DockButton({ icon, label, onClick, active }: DockAction): React.JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...buttonStyle,
        ...(active ? buttonActiveStyle : {}),
        ...(hover  ? buttonHoverStyle  : {}),
      }}
      title={label}
    >
      <span style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span>
      {hover && <span style={tooltipStyle}>{label}</span>}
    </button>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const dockStyle: React.CSSProperties = {
  position:       'fixed',
  right:          12,
  top:            '50%',
  transform:      'translateY(-50%)',
  display:        'flex',
  flexDirection:  'column',
  gap:            8,
  padding:        8,
  background:     'rgba(20, 22, 30, 0.75)',
  border:         '1px solid rgba(255,255,255,0.08)',
  borderRadius:   24,
  backdropFilter: 'blur(8px)',
  zIndex:         100,
};

const buttonStyle: React.CSSProperties = {
  position:     'relative',
  width:        36,
  height:       36,
  borderRadius: '50%',
  border:       '1px solid rgba(255,255,255,0.1)',
  background:   'rgba(40, 42, 52, 0.6)',
  color:        '#f5f5f5',
  cursor:       'pointer',
  display:      'flex',
  alignItems:   'center',
  justifyContent: 'center',
  transition:   'background 0.15s ease, transform 0.1s ease',
  padding:      0,
};

const buttonHoverStyle: React.CSSProperties = {
  background:   'rgba(70, 75, 90, 0.85)',
  transform:    'scale(1.08)',
};

const buttonActiveStyle: React.CSSProperties = {
  background:   'rgba(80, 120, 200, 0.75)',
  borderColor:  'rgba(120, 160, 240, 0.8)',
};

const tooltipStyle: React.CSSProperties = {
  position:     'absolute',
  right:        44,
  top:          '50%',
  transform:    'translateY(-50%)',
  whiteSpace:   'nowrap',
  fontSize:     12,
  padding:      '4px 8px',
  background:   'rgba(20, 22, 30, 0.95)',
  border:       '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  pointerEvents: 'none',
};
