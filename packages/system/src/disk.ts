import { execSync } from 'node:child_process';
import * as os from 'node:os';

export interface DiskInfo {
  /** Drive letter or mount point, e.g. "C:" or "/dev/sda1" */
  mount:     string;
  /** Human-readable label, e.g. "Windows-SSD" */
  label:     string;
  /** Total bytes */
  total:     number;
  /** Free bytes */
  free:      number;
}

// ── Platform implementations ──────────────────────────────────────────────────

function getDisksWindows(): DiskInfo[] {
  // wmic is deprecated and emits the OEM codepage (e.g. GBK on zh-CN), which
  // garbles non-ASCII volume labels when decoded as UTF-8. PowerShell lets us
  // force UTF-8 on stdout and emit clean JSON.
  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    'Get-CimInstance Win32_LogicalDisk | ' +
    'Where-Object { $_.Size -gt 0 } | ' +
    'Select-Object DeviceID,VolumeName,Size,FreeSpace | ' +
    'ConvertTo-Json -Compress';

  const raw = execSync(
    `powershell -NoProfile -NonInteractive -Command "${script}"`,
    { encoding: 'utf8', timeout: 5000 },
  ).trim();
  if (!raw) return [];

  type Row = { DeviceID: string; VolumeName: string | null; Size: number; FreeSpace: number };
  const parsed = JSON.parse(raw) as Row | Row[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  const result: DiskInfo[] = [];
  for (const row of rows) {
    const mount = (row.DeviceID ?? '').trim();
    const total = Number(row.Size ?? 0);
    const free  = Number(row.FreeSpace ?? 0);
    const label = (row.VolumeName ?? '').trim();
    if (!mount || !total) continue;
    result.push({ mount, label: label || mount, total, free });
  }
  return result;
}

function getDisksPosix(): DiskInfo[] {
  // df -Pk gives POSIX output: Filesystem, 1024-blocks, Used, Available, Capacity%, Mounted on
  const raw = execSync('df -Pk', { encoding: 'utf8', timeout: 5000 });
  const lines = raw.trim().split('\n').slice(1); // skip header

  return lines
    .map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      const total    = parseInt(parts[1]!, 10) * 1024;
      const used     = parseInt(parts[2]!, 10) * 1024;
      const free     = total - used;
      const mount    = parts[5]!;
      // Skip pseudo-filesystems
      if (mount.startsWith('/sys') || mount.startsWith('/proc') || mount === '/dev') return null;
      return { mount, label: mount, total, free };
    })
    .filter((d): d is DiskInfo => d !== null && d.total > 0);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getDisksInfo(): DiskInfo[] {
  try {
    return os.platform() === 'win32' ? getDisksWindows() : getDisksPosix();
  } catch {
    return [];
  }
}

// TODO: getDirSize(dirPath: string): number
// Recursively stat all files under dirPath and sum their sizes.
// Needed for per-session data footprint display.
