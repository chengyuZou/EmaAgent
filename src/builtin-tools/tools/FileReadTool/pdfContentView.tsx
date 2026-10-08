import type { JSX } from 'react';
import { Badge } from '@ema-agent/ui';
import type { PdfReadResult } from './pdfReader.js';

const PREVIEW_CHARS = 2_000;

export function PdfContentView({ result }: { result: PdfReadResult }): JSX.Element {
  const preview = result.content.slice(0, PREVIEW_CHARS);
  const omitted = result.content.length - preview.length;
  return (
    <div className="flex flex-col gap-1 text-[11px] leading-relaxed">
      <div className="flex items-center gap-2">
        <span className="text-[var(--ema-text-secondary)]">
          第 {result.startPage}–{result.endPage} 页 · 共 {result.totalPages} 页
        </span>
        {result.nextPage !== undefined && (
          <Badge variant="warn">可继续读取第 {result.nextPage} 页</Badge>
        )}
        {result.warnings.length > 0 && (
          <Badge variant="danger">读取不完整 {result.warnings.length} 处</Badge>
        )}
      </div>
      {result.warnings.length > 0 && (
        <ul className="m-0 list-inside list-disc text-[var(--ema-text-secondary)]">
          {result.warnings.map((warning, index) => (
            <li key={`${warning.page}:${warning.code}:${index}`}>
              第 {warning.page} 页: {warning.message}
            </li>
          ))}
        </ul>
      )}
      <div>
        <pre className="m-0 whitespace-pre bg-transparent p-0 font-mono text-[var(--ema-text-secondary)]">
          {preview}
          {omitted > 0 && `\n··· 其余 ${omitted.toLocaleString()} 字符 ···`}
        </pre>
      </div>
    </div>
  );
}
