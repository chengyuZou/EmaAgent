export function fmtBytes(n: number): string {
  if (n === 0)           return '0 B';
  if (n < 1_024)         return `${n} B`;
  if (n < 1_048_576)     return `${(n / 1_024).toFixed(1)} KB`;
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(2)} MB`;
  return `${(n / 1_073_741_824).toFixed(2)} GB`;
}

export function fmtDuration(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function fmtTokens(n: number): string {
  if (n < 1_000) return String(n);
  return `${(n / 1_000).toFixed(1)}k`;
}

export function fmtDateShort(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', {
    month: '2-digit', day: '2-digit',
  });
}

export function fmtDateFull(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}
