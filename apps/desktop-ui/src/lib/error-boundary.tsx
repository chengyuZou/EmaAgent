/**
 * Error boundary — catch render errors and show fallback UI.
 *
 * Placed at the root of each sub-window (ChatPanel / SettingsPanel / App).
 */
import { Component, type ReactNode } from 'react';
import type { ErrorInfo } from 'react';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback render. Default: red callout + "重新加载" button. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
          <div className="text-lg font-semibold" style={{ color: 'var(--ema-danger)' }}>
            出错了
          </div>
          <pre className="text-xs max-w-md overflow-auto whitespace-pre-wrap rounded-xl p-4"
               style={{ color: 'var(--ema-text-tertiary)', background: 'var(--ema-surface-0)' }}>
            {this.state.error.message}
          </pre>
          <button
            className="px-4 py-2 rounded-xl transition-colors"
            style={{ background: 'var(--ema-primary-muted)', color: 'var(--ema-primary)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'oklch(0.72 0.18 350 / 0.30)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ema-primary-muted)'; }}
            onClick={this.reset}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
