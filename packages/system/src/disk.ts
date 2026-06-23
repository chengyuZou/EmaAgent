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
  // wmic logicaldisk: Caption=drive letter, VolumeName=label, Size=total, FreeSpace=free
  const raw = execSync(
    'wmic logicaldisk get Caption,VolumeName,Size,FreeSpace /format:csv',
    { encoding: 'utf8', timeout: 5000 },
  );

  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  // First non-empty line is the header row (Node,Caption,FreeSpace,Size,VolumeName)
  if (lines.length < 2) return [];

  const header = lines[0]!.split(',').map(h => h.trim());
  const captionIdx   = header.indexOf('Caption');
  const freeIdx      = header.indexOf('FreeSpace');
  const sizeIdx      = header.indexOf('Size');
  const labelIdx     = header.indexOf('VolumeName');

  const result: DiskInfo[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols  = lines[i]!.split(',');
    const mount = cols[captionIdx]?.trim() ?? '';
    const total = parseInt(cols[sizeIdx]?.trim() ?? '0', 10);
    const free  = parseInt(cols[freeIdx]?.trim() ?? '0', 10);
    const label = cols[labelIdx]?.trim() ?? '';
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
