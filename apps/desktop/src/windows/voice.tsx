import React from 'react';
import { createRoot } from 'react-dom/client';
import { SubWindowPlaceholder } from './shared/SubWindowPlaceholder.js';

// ── Voice (refAudio management) sub-window entry ────────────────────────────
//
// Real UI: 上传 / 列表 / 试听 / 设为 primary / 删除 角色 refAudio。
// Calls into POST /api/cards/:id/voice-refs etc. (already implemented in 6B-3).

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in voice.html');

createRoot(container).render(
  <React.StrictMode>
    <SubWindowPlaceholder
      title="角色音色"
      hint="P1-1c-next 会做：上传参考音频、列表管理、试听、设主用项、删除。后端端点 6B-3 已经在了。"
    />
  </React.StrictMode>,
);
