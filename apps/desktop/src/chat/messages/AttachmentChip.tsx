// AttachmentChip — 输入框附件预览卡；点击查看、移除与文件类型提示共用这一处。
import type { JSX } from 'react';

// ── 按 MIME/扩展名取图标与颜色 ────────────────────────────────────────────────

export function chipMeta(mime: string, name: string): { icon: string; color: string } {
  if (mime.startsWith('image/'))
    return { icon: 'i-mdi:image-outline',          color: 'var(--ema-file-image)' };

  if (mime === 'application/pdf')
    return { icon: 'i-mdi:file-pdf-box',            color: 'var(--ema-file-pdf)' };

  if (mime.includes('wordprocessingml') || mime.includes('msword') || name.endsWith('.doc') || name.endsWith('.docx'))
    return { icon: 'i-mdi:file-word',               color: 'var(--ema-file-word)' };

  if (mime.includes('presentationml') || mime.includes('powerpoint') || name.endsWith('.ppt') || name.endsWith('.pptx'))
    return { icon: 'i-mdi:file-powerpoint',         color: 'var(--ema-file-ppt)' };

  if (mime.includes('spreadsheetml') || mime.includes('excel') || name.endsWith('.xls') || name.endsWith('.xlsx'))
    return { icon: 'i-mdi:file-excel',              color: 'var(--ema-file-excel)' };

  if (mime.startsWith('text/x-') || mime === 'application/json' ||
      /\.(ts|tsx|js|jsx|py|rs|go|cpp|c|java|rb|php|sh|yaml|yml|toml|sql)$/.test(name))
    return { icon: 'i-mdi:file-code-outline',       color: 'var(--ema-file-code)' };

  if (mime.startsWith('text/'))
    return { icon: 'i-mdi:file-document-outline',   color: 'var(--ema-file-text)' };

  return   { icon: 'i-lucide:paperclip',               color: 'var(--ema-file-other)' };
}

function fmtSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024)        return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return                          `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// ── Component ─────────────────────────────────────────────────────────────────

/** 输入框待发送附件的展示输入（TurnAttachmentInput 的展示字段子集）。 */
export interface AttachmentChipProps {
  attachment: {
    name?: string;
    mimeType?: string;
    size?: number;
  };
  /** 传入即显示 ✕ 移除按钮。 */
  onRemove?: () => void;
  onOpen?: () => void;
}

export function AttachmentChip({ attachment, onRemove, onOpen }: AttachmentChipProps): JSX.Element {
  const name = attachment.name ?? '附件';
  const { icon, color } = chipMeta(attachment.mimeType ?? '', name);
  const sizeStr = fmtSize(attachment.size ?? 0);

  return (
    <div
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 group transition-colors ema-chip-in bg-[var(--ema-surface-2)] ${onOpen ? 'cursor-pointer hover:bg-[var(--ema-surface-3)]' : ''}`}
      style={{
        width:      152,
        border:     '1px solid var(--ema-border)',
      }}
      title={name}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') onOpen();
      } : undefined}
    >
      {/* 文件类型图标 */}
      <span
        className={`${icon} text-base shrink-0`}
        style={{ color }}
        aria-hidden
      />

      {/* 文件名 + 大小 */}
      <div className="flex-1 min-w-0">
        <div
          className="text-[11px] leading-tight truncate font-medium text-[var(--ema-text-primary)]"
        >
          {name}
        </div>
        {sizeStr && (
          <div className="text-[10px] leading-none mt-0.5 text-[var(--ema-text-tertiary)]">
            {sizeStr}
          </div>
        )}
      </div>

      {/* 移除按钮（仅输入预览态显示） */}
      {onRemove && (
        <button
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity -mr-0.5 text-[var(--ema-text-tertiary)] hover:text-[var(--ema-danger)]"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          aria-label={`移除 ${name}`}
        >
          <span className="i-lucide:x text-sm" aria-hidden />
        </button>
      )}
    </div>
  );
}
