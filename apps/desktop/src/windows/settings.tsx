import React from 'react';
import { createRoot } from 'react-dom/client';
import { SubWindowPlaceholder } from './shared/SubWindowPlaceholder.js';

// ── Settings sub-window entry ───────────────────────────────────────────────
//
// Real settings UI (AIRI-style 服务来源 / 机体模块 / Data) lands in P1-3.
// This placeholder verifies the multi-window pipeline only.

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in settings.html');

createRoot(container).render(
  <React.StrictMode>
    <SubWindowPlaceholder
      title="设置"
      hint="P1-3 会做：provider 卡片 + API key 输入 + model_bindings(chat/narrative/agent/tts_*/stt/...) 配置 + 健康检查按钮。"
    />
  </React.StrictMode>,
);
