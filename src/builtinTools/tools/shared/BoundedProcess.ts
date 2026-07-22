// 这里负责流式读取搜索子进程，并在记录数、字节数、时间或取消信号达到边界时终止它。
import { spawn } from 'node:child_process';

export type BoundedProcessStopReason = 'records' | 'bytes' | 'timeout';

export interface BoundedProcessOptions {
  cwd?: string;
  delimiter: '\n' | '\0';
  maxRecords: number;
  maxBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
  allowedExitCodes?: readonly number[];
}

export interface BoundedProcessResult {
  records: string[];
  truncated: boolean;
  stopReason?: BoundedProcessStopReason;
}

export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const records: string[] = [];
    const allowedExitCodes = new Set(options.allowedExitCodes ?? [0]);
    let carry = '';
    let stderr = '';
    let bytes = 0;
    let stopReason: BoundedProcessStopReason | undefined;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      callback();
    };
    const stop = (reason: BoundedProcessStopReason): void => {
      if (stopReason) return;
      stopReason = reason;
      child.kill();
    };
    const pushRecord = (record: string): void => {
      if (record.length === 0 || stopReason) return;
      if (records.length >= options.maxRecords) {
        stop('records');
        return;
      }
      records.push(record);
    };
    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (stopReason || aborted) return;
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        stop('bytes');
        return;
      }
      carry += chunk.toString('utf8');
      const parts = carry.split(options.delimiter);
      carry = parts.pop() ?? '';
      for (const part of parts) {
        pushRecord(part.replace(/\r$/, ''));
        if (stopReason) break;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString('utf8');
    });
    child.once('error', error => finish(() => reject(error)));
    child.once('close', code => {
      if (!stopReason && !aborted) pushRecord(carry.replace(/\r$/, ''));
      if (aborted) {
        const reason = options.signal.reason;
        finish(() => reject(reason instanceof Error ? reason : new Error('搜索已取消')));
        return;
      }
      if (!stopReason && !allowedExitCodes.has(code ?? -1)) {
        finish(() => reject(new Error(
          `${command} exited with code ${String(code)}${stderr ? `: ${stderr.trim()}` : ''}`,
        )));
        return;
      }
      finish(() => resolve({
        records,
        truncated: stopReason !== undefined,
        ...(stopReason ? { stopReason } : {}),
      }));
    });

    timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    timer.unref?.();
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  });
}
