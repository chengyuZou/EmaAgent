// 这里读取本机磁盘信息（Windows 用 PowerShell、POSIX 用 df），供设置页存储位置显示用。

import { execSync } from 'node:child_process';
import * as os from 'node:os';

export interface DiskInfo {
  /** 盘符或挂载点，如 "C:" 或 "/dev/sda1" */
  mount:     string;
  /** 人可读的卷标，如 "Windows-SSD" */
  label:     string;
  /** 总字节数 */
  total:     number;
  /** 可用字节数 */
  free:      number;
}

// ── 各平台实现 ─────────────────────────────────────────────────────────────────

function getDisksWindows(): DiskInfo[] {
  // wmic 已废弃，且输出 OEM 代码页（zh-CN 是 GBK），按 UTF-8 解会乱码卷标。
  // PowerShell 能强制 stdout 为 UTF-8 并输出干净 JSON。
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
  // df -Pk 输出 POSIX 格式：Filesystem、1024-块、已用、可用、容量%、挂载点
  const raw = execSync('df -Pk', { encoding: 'utf8', timeout: 5000 });
  const lines = raw.trim().split('\n').slice(1); // 跳过表头

  return lines
    .map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      const total    = parseInt(parts[1]!, 10) * 1024;
      const used     = parseInt(parts[2]!, 10) * 1024;
      const free     = total - used;
      const mount    = parts[5]!;
      // 跳过伪文件系统
      if (mount.startsWith('/sys') || mount.startsWith('/proc') || mount === '/dev') return null;
      return { mount, label: mount, total, free };
    })
    .filter((d): d is DiskInfo => d !== null && d.total > 0);
}

// ── 对外接口 ───────────────────────────────────────────────────────────────────

export function getDisksInfo(): DiskInfo[] {
  try {
    return os.platform() === 'win32' ? getDisksWindows() : getDisksPosix();
  } catch {
    return [];
  }
}

// TODO: getDirSize(dirPath: string): number
// 递归 stat dirPath 下所有文件并累加大小。
// 用于按 Session 展示数据占用。
