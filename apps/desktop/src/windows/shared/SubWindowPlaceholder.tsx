// ── SubWindowPlaceholder ────────────────────────────────────────────────────
//
// Shared "this window is alive but not implemented yet" surface. Used by all
// sub-windows in P1-1c so the multi-window pipeline (vite multi-page + Tauri
// pre-declared windows + invoke open_window) can be validated end-to-end
// before each window's real UI lands.
//
// Each sub-window passes its own title + hint describing what will live here.

export interface SubWindowPlaceholderProps {
  title: string;
  hint:  string;
}

export function SubWindowPlaceholder({ title, hint }: SubWindowPlaceholderProps): React.JSX.Element {
  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <div style={kickerStyle}>EMA · 占位窗口</div>
        <h1 style={titleStyle}>{title}</h1>
        <p style={hintStyle}>{hint}</p>
        <div style={dividerStyle} />
        <p style={metaStyle}>
          这个窗口通过 Tauri pre-declared window + <code style={codeStyle}>invoke('open_window')</code> 打开，
          说明 vite 多页 + 子窗 wiring 已通。
        </p>
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  height:         '100%',
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'center',
  padding:        24,
  background:     'linear-gradient(135deg, #1a1c26 0%, #14161e 100%)',
};

const cardStyle: React.CSSProperties = {
  maxWidth:       520,
  padding:        '28px 32px',
  background:     'rgba(30, 32, 42, 0.85)',
  border:         '1px solid rgba(255, 214, 230, 0.18)',
  borderRadius:   12,
  boxShadow:      '0 8px 32px rgba(0, 0, 0, 0.4)',
};

const kickerStyle: React.CSSProperties = {
  fontSize:      11,
  letterSpacing: '0.18em',
  color:         'rgba(255, 214, 230, 0.7)',
  marginBottom:  8,
};

const titleStyle: React.CSSProperties = {
  margin:       '0 0 12px',
  fontSize:     22,
  fontWeight:   500,
};

const hintStyle: React.CSSProperties = {
  margin:       0,
  fontSize:     14,
  lineHeight:   1.7,
  color:        'rgba(245, 245, 245, 0.78)',
};

const dividerStyle: React.CSSProperties = {
  height:       1,
  background:   'rgba(255, 255, 255, 0.08)',
  margin:       '20px 0 16px',
};

const metaStyle: React.CSSProperties = {
  margin:       0,
  fontSize:     12,
  lineHeight:   1.6,
  color:        'rgba(245, 245, 245, 0.45)',
};

const codeStyle: React.CSSProperties = {
  background:    'rgba(255, 255, 255, 0.08)',
  padding:       '1px 5px',
  borderRadius:  3,
  fontFamily:    'Consolas, Monaco, monospace',
  fontSize:      11,
};
