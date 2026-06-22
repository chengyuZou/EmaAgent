/**
 * AttachmentChip — single file attachment displayed as a chip.
 * Used in both the ChatInput preview (with remove button) and UserBubble history.
 */
import type { JSX } from 'react';
import { tauriBridge } from '../lib/tauri-bridge.js';
import type { AttachmentInputWire } from '../api/turns.js';

// ── Icon + color by MIME ──────────────────────────────────────────────────────

function chipMeta(mime: string, name: string): { icon: string; color: string } {
  if (mime.startsWith('image/'))
    return { icon: 'i-mdi:image-outline',          color: 'oklch(0.72 0.14 160)' };  // teal

  if (mime === 'application/pdf')
    return { icon: 'i-mdi:file-pdf-box',            color: 'oklch(0.65 0.20 25)'  };  // red

  if (mime.includes('wordprocessingml') || mime.includes('msword') || name.endsWith('.doc') || name.endsWith('.docx'))
    return { icon: 'i-mdi:file-word',               color: 'oklch(0.60 0.18 255)' };  // blue

  if (mime.includes('presentationml') || mime.includes('powerpoint') || name.endsWith('.ppt') || name.endsWith('.pptx'))
    return { icon: 'i-mdi:file-powerpoint',         color: 'oklch(0.65 0.19 45)'  };  // orange

  if (mime.includes('spreadsheetml') || mime.includes('excel') || name.endsWith('.xls') || name.endsWith('.xlsx'))
    return { icon: 'i-mdi:file-excel',              color: 'oklch(0.65 0.18 150)' };  // green

  if (mime.startsWith('text/x-') || mime === 'application/json' ||
      /\.(ts|tsx|js|jsx|py|rs|go|cpp|c|java|rb|php|sh|yaml|yml|toml|sql)$/.test(name))
    return { icon: 'i-mdi:file-code-outline',       color: 'oklch(0.72 0.14 75)'  };  // amber

  if (mime.startsWith('text/'))
    return { icon: 'i-mdi:file-document-outline',   color: 'oklch(0.65 0.04 250)' };  // neutral

  return   { icon: 'i-mdi:paperclip',               color: 'oklch(0.60 0.04 250)' };
}

function fmtSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024)        return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return                          `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface AttachmentChipProps {
  attachment: AttachmentInputWire;
  /** Show ✕ remove button (input preview mode). */
  onRemove?: () => void;
}

export function AttachmentChip({ attachment, onRemove }: AttachmentChipProps): JSX.Element {
  const { icon, color } = chipMeta(attachment.mimeType, attachment.name);
  const sizeStr = fmtSize(attachment.size);

  const handleOpen = (): void => {
    if (attachment.localPath) {
      void tauriBridge.openPath(attachment.localPath).catch(() => {});
    }
  };

  return (
    <div
      className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 cursor-pointer group transition-colors"
      style={{
        width:      152,
        background: 'rgba(255,255,255,0.05)',
        border:     '1px solid rgba(255,255,255,0.08)',
      }}
      onClick={handleOpen}
      title={attachment.localPath || attachment.name}
    >
      {/* File type icon */}
      <span
        className={`${icon} text-base shrink-0`}
        style={{ color }}
        aria-hidden
      />

      {/* Name + size */}
      <div className="flex-1 min-w-0">
        <div
          className="text-[11px] leading-tight truncate font-medium"
          style={{ color: 'var(--ema-text-primary)' }}
        >
          {attachment.name}
        </div>
        {sizeStr && (
          <div className="text-[10px] leading-none mt-0.5" style={{ color: 'var(--ema-text-tertiary)' }}>
            {sizeStr}
          </div>
        )}
      </div>

      {/* Remove button (input preview only) */}
      {onRemove && (
        <button
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400 -mr-0.5"
          style={{ color: 'var(--ema-text-tertiary)' }}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          aria-label={`移除 ${attachment.name}`}
        >
          <span className="i-mdi:close text-sm" aria-hidden />
        </button>
      )}
    </div>
  );
}
