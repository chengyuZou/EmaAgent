export function fmtBytes(bytes: number): string {
  if (bytes === 0)           return '0 B';
  if (bytes < 1_024)         return `${bytes} B`;
  if (bytes < 1_048_576)     return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

export function fmtDuration(durationMs: number | null): string {
  if (durationMs === null) return '-';
  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function fmtTokens(tokenCount: number): string {
  if (tokenCount < 1_000) return String(tokenCount);
  else if (tokenCount < 1_000_000) return `${(tokenCount / 1_000).toFixed(1)}k`;
  else return `${(tokenCount / 1_000_000).toFixed(1)}M`;
}

export function fmtDateShort(timestampMs: number): string {
  return new Date(timestampMs).toLocaleDateString('zh-CN', {
    month: '2-digit', day: '2-digit',
  });
}

export function fmtDateFull(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}
