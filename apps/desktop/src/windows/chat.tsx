import React from 'react';
import { createRoot } from 'react-dom/client';
import { SubWindowPlaceholder } from './shared/SubWindowPlaceholder.js';

// ── Chat sub-window entry ───────────────────────────────────────────────────
//
// Real chat UI (left session list / center messages / bottom input / top
// mode selector) lands in the next round. This entry just renders the
// placeholder so the window opens, draws, and confirms the multi-window
// pipeline (vite multi-page + Tauri pre-declared window + invoke open_window).

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in chat.html');

createRoot(container).render(
  <React.StrictMode>
    <SubWindowPlaceholder
      title="聊天"
      hint="P1-1c-next 会做：左侧 session 列表、中间消息历史、底部输入框、顶部 chat/narrative/agent 模式切换。"
    />
  </React.StrictMode>,
);
