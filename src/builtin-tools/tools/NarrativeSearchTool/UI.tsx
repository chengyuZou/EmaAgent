import type { JSX } from 'react';
import { CodeViewer } from '@ema-agent/ui';

export function narrativeSearchResultCopyText(data: unknown): string | null {
  if (data === undefined) return null;
  return JSON.stringify(data, null, 2);
}

export function NarrativeSearchResultView({ data }: { data: unknown }): JSX.Element | null {
  const source = narrativeSearchResultCopyText(data);
  if (source === null) return null;
  return <CodeViewer source={source} language="json" embedded wrapLines={false} />;
}
