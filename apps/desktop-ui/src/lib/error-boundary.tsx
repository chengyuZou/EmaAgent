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
          <div className="text-red-400 text-lg font-semibold">
            出错了
          </div>
          <pre className="text-xs text-gray-500 max-w-md overflow-auto whitespace-pre-wrap bg-gray-900 rounded-xl p-4">
            {this.state.error.message}
          </pre>
          <button
            className="px-4 py-2 rounded-xl bg-pink-400/20 text-pink-300 hover:bg-pink-400/30 transition-colors"
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
