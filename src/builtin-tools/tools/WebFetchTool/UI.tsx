// WebFetchTool 的桌面展示: 参数行(URL + raw 徽标)与结果卡(字节/状态码 + 内容预览)。
// 只消费本 Tool 的类型化 data; 类型守卫失败返回 null, 由前端回落通用渲染。
import type { JSX } from 'react';
import { Badge } from '@ema-agent/ui';
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
      </div>
      <div className="max-h-40 overflow-auto rounded-md border border-[var(--ema-border)] px-2 py-1">
        <pre className="m-0 whitespace-pre-wrap break-all bg-transparent p-0 font-mono text-[var(--ema-text-secondary)]">
          {preview}
          {omitted > 0 && `\n··· 其余 ${omitted.toLocaleString()} 字符 ···`}
        </pre>
      </div>
    </div>
  );
}
