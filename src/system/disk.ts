import { execSync } from 'node:child_process';
import * as os from 'node:os';

export interface DiskInfo {
  /** Windows 盘符或 POSIX 挂载路径, 如 "C:" 或 "/". */
  mount:     string;
  /** Windows 卷标为空时使用盘符; POSIX 使用挂载路径. */
  label:     string;
  /** 总字节数. */
  total:     number;
  /** 未用字节数. POSIX 使用总量减已用量, 包括普通用户可能无法使用的保留空间. */
  free:      number;
}

function getDisksWindows(): DiskInfo[] {
  // 明确 PowerShell 输出编码, 避免 UTF-8 读取时把本地语言的卷标解错.
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
  // -P 固定输出列, -k 使用 1024 字节块. 这里将容量换算为字节.
  const raw = execSync('df -Pk', { encoding: 'utf8', timeout: 5000 });
  const lines = raw.trim().split('\n').slice(1);

  return lines
    .map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      const total    = parseInt(parts[1]!, 10) * 1024;
      const used     = parseInt(parts[2]!, 10) * 1024;
      const free     = total - used;
      const mount    = parts[5]!;
      if (mount.startsWith('/sys') || mount.startsWith('/proc') || mount === '/dev') return null;
      return { mount, label: mount, total, free };
    })
    .filter((d): d is DiskInfo => d !== null && d.total > 0);
}

/** 同步查询本机磁盘. 命令失败或超时时返回空列表. */
export function getDisksInfo(): DiskInfo[] {
  try {
    return os.platform() === 'win32' ? getDisksWindows() : getDisksPosix();
  } catch {
    return [];
  }
}
