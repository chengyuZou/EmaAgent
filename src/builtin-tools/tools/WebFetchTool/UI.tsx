// WebFetchTool 的桌面展示: 参数行(URL + raw 徽标)与结果卡(字节/状态码 + 内容预览).
// 内容是 HTML 时给源码/沙箱预览切换; 其余保持文本预览。
import { useState, type JSX } from 'react';
import { Badge, Button } from '@ema-agent/ui';
import type { WebFetchResult } from './WebFetchTool.js';

const PREVIEW_CHARS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 行头摘要：抓取 URL。 */
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

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function WebFetchArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['url'] !== 'string') return null;
  return (
    <div className="flex items-center gap-2 text-[11px] leading-relaxed">
      <span className="break-all text-[var(--ema-text-secondary)]">{args['url']}</span>
      {args['raw'] === true && <Badge variant="warn">raw</Badge>}
    </div>
  );
}

export function WebFetchResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asWebFetchResult(data);
  if (!result) return null;
  return <WebFetchResultCard result={result} />;
}

function WebFetchResultCard({ result }: { result: WebFetchResult }): JSX.Element {
  const isHtml = /^\s*(<!doctype\s+html|<html[\s>])/i.test(result.content);
  const [showPreview, setShowPreview] = useState(false);
  const preview = result.content.slice(0, PREVIEW_CHARS);
  const omitted = result.content.length - preview.length;
  return (
    <div className="flex flex-col gap-1 text-[11px] leading-relaxed">
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
        {isHtml && (
          <span className="ml-auto flex gap-1">
            <Button variant={showPreview ? 'ghost' : 'secondary'} size="sm" onClick={() => setShowPreview(false)}>
              源码
            </Button>
            <Button variant={showPreview ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowPreview(true)}>
              预览
            </Button>
          </span>
        )}
      </div>
      {isHtml && showPreview ? (
        /* sandbox 空属性: 禁脚本禁表单, 公网内容只渲染视觉. */
        <iframe
          sandbox=""
          srcDoc={preview}
          title="网页预览"
          className="h-48 w-full rounded-md border border-[var(--ema-border)] bg-white"
        />
      ) : (
        <div className="max-h-40 overflow-auto rounded-md border border-[var(--ema-border)] px-2 py-1">
          <pre className="m-0 whitespace-pre-wrap break-all bg-transparent p-0 font-mono text-[var(--ema-text-secondary)]">
            {preview}
            {omitted > 0 && `\n··· 其余 ${omitted.toLocaleString()} 字符 ···`}
          </pre>
        </div>
      )}
    </div>
  );
}
