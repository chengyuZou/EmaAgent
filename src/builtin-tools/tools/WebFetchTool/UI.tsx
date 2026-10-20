import type { JSX } from 'react';
import { Tooltip, Badge, CodeViewer, HtmlBlock } from '@ema-agent/ui';
import type { WebFetchResult } from './WebFetchTool.js';

const PREVIEW_CHARS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function webFetchTitle(args: unknown): string | null {
  return isRecord(args) && typeof args['url'] === 'string' ? args['url'] : null;
}

function asWebFetchResult(data: unknown): WebFetchResult | null {
  if (!isRecord(data) || typeof data['url'] !== 'string' || typeof data['content'] !== 'string') {
    return null;
  }
  if (typeof data['bytes'] !== 'number' || typeof data['code'] !== 'number') return null;
  if (typeof data['truncated'] !== 'boolean') return null;
  return data as unknown as WebFetchResult;
}

export function webFetchResultCopyText(data: unknown): string | null {
  return asWebFetchResult(data)?.content ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function WebFetchArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['url'] !== 'string') return null;
  return (
    <div className="flex items-center gap-2 text-[11px] leading-relaxed">
      <Tooltip content={args['url']} variant="card">
        <a
          href={args['url']}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-[var(--ema-primary)] transition-colors hover:text-[var(--ema-primary-hover)] hover:underline"
        >
          {args['url']}
        </a>
      </Tooltip>
      {args['raw'] === true && <Badge variant="warn">raw</Badge>}
    </div>
  );
}

export function WebFetchResultView({ data, toolbarContainer }: {
  readonly data: unknown;
  readonly toolbarContainer?: HTMLElement | null;
}): JSX.Element | null {
  const result = asWebFetchResult(data);
  if (!result) return null;
  return <WebFetchResultCard result={result} toolbarContainer={toolbarContainer} />;
}

function WebFetchResultCard({ result, toolbarContainer }: {
  readonly result: WebFetchResult;
  readonly toolbarContainer?: HTMLElement | null;
}): JSX.Element {
  const isHtml = /^\s*(<!doctype\s+html|<html[\s>])/i.test(result.content);
  return (
    <div className="ema-tool-result-layout flex min-w-0 flex-col text-[11px] leading-relaxed">
      <div className="ema-tool-result-details flex min-w-0 flex-col gap-1">
        <Tooltip content={result.url} variant="card">
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate text-[var(--ema-primary)] transition-colors hover:text-[var(--ema-primary-hover)] hover:underline"
          >
            {result.url}
          </a>
        </Tooltip>
        <div className="flex items-center gap-2">
          <span className="text-[var(--ema-text-secondary)]">
            收到 <span className="font-medium text-[var(--ema-text-primary)]">
              {formatBytes(result.bytes)}
            </span>
            <span className="text-[var(--ema-text-tertiary)]">
              {' '}({result.code} {result.codeText})
            </span>
          </span>
          {result.truncated && <Badge variant="warn">已截断</Badge>}
          {result.download && <Badge variant="success">已下载文件</Badge>}
        </div>
      </div>
      {isHtml ? (
        <HtmlBlock
          source={result.content}
          previewSource={result.content.slice(0, PREVIEW_CHARS)}
          wrapLines={false}
          toolbarContainer={toolbarContainer}
        />
      ) : (
        <CodeViewer source={result.content} embedded wrapLines={false} />
      )}
    </div>
  );
}
