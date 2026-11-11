import 'virtual:uno.css';
import '../styles/index.css';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@ema-agent/ui';
import { CaptionWindow } from '../caption/CaptionWindow.js';
import { ErrorBoundary } from '../lib/errorBoundary.js';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in caption.html');

createRoot(container).render(
  <ErrorBoundary>
    <TooltipProvider>
      <CaptionWindow />
    </TooltipProvider>
  </ErrorBoundary>,
);
