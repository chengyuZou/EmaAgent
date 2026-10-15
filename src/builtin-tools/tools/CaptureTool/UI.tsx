import type { JSX } from 'react';
import { Tooltip } from '@ema-agent/ui';
import type { FileReadImageResult } from '../FileReadTool/imageReader.js';

function isCaptureResult(data: unknown): data is FileReadImageResult {
  return typeof data === 'object' && data !== null
    && 'type' in data && data.type === 'image_content'
    && 'filePath' in data && typeof data.filePath === 'string'
    && 'mediaType' in data && typeof data.mediaType === 'string'
    && 'base64' in data && typeof data.base64 === 'string'
    && 'originalBytes' in data && typeof data.originalBytes === 'number';
}

export function captureTitle(): string {
  return '当前屏幕';
}

export function captureResultCopyText(data: unknown): string | null {
  return isCaptureResult(data) ? data.filePath : null;
}

export function CaptureResultView({ data, renderImage }: {
  readonly data: unknown;
  readonly renderImage: (image: { readonly src: string; readonly alt: string }) => JSX.Element;
}): JSX.Element | null {
  if (!isCaptureResult(data)) return null;

  return (
    <Tooltip content={`${data.mediaType} · ${(data.originalBytes / 1024).toFixed(1)} KB`}>
      <span className="inline-flex w-fit max-w-full">
        {renderImage({
          src: `data:${data.mediaType};base64,${data.base64}`,
          alt: data.filePath,
        })}
      </span>
    </Tooltip>
  );
}
