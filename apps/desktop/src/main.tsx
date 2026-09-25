import 'virtual:uno.css';
import './styles/index.css';
/* KaTeX 公式样式: Markdown 渲染器(rehype-katex)只产 markup, 样式表必须全局引入. */
import 'katex/dist/katex.min.css';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@ema-agent/ui';
import { ErrorBoundary } from './lib/error-boundary.js';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in index.html');

createRoot(container).render(
  // 主窗口持有 Pixi/WebGL 的命令式生命周期。开发期双挂载会并发创建两套模型,
  // 第一套异步清理可能破坏第二套仍在使用的 Live2D 资源。
  <ErrorBoundary fallback={(err, reset) => (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(14, 12, 20, 0.97)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 16, padding: 32, borderRadius: 16,
      color: '#f8f8f8', fontFamily: 'sans-serif',
    }}>
      <div style={{ color: '#f87171', fontSize: 16, fontWeight: 600 }}>
        Ema 渲染出错
      </div>
      <pre style={{
        fontSize: 12, color: '#9ca3af', maxWidth: 360,
        overflow: 'auto', whiteSpace: 'pre-wrap',
        background: 'rgba(0,0,0,0.4)', borderRadius: 8, padding: '8px 12px',
      }}>
        {err.message}
      </pre>
      <button
        onClick={reset}
        style={{
          padding: '6px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: 'rgba(244, 114, 182, 0.25)', color: '#f9a8d4',
        }}
      >
        重新加载
      </button>
    </div>
  )}>
    <TooltipProvider delayDuration={300}>
      <App />
    </TooltipProvider>
  </ErrorBoundary>,
);
