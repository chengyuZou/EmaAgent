import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  CommandOutputChunk,
  CommandProcessHandle,
  CommandRunResult,
  ProcessCommand,
} from '../types.js';

// 字符串预算按 UTF-16 码元计算, 不是字节数. stdout/stderr 各占一半.
const MAX_OUTPUT_CHARS = 200_000;
const MAX_STREAM_CHARS = MAX_OUTPUT_CHARS / 2;
const FORCE_KILL_DELAY_MS = 3_000;

export function startProcess(
  command: ProcessCommand,
  timeoutMs: number,
  signal?: AbortSignal,
  onOutput?: (chunk: CommandOutputChunk) => void,
): CommandProcessHandle {
  let stopProcess = (): void => undefined;
  const completion = new Promise<CommandRunResult>((resolve, reject) => {
    // 已取消时不启动进程, 即使可执行文件不存在也直接返回取消结果.
    if (signal?.aborted) {
      resolve({
        stdout: '', stderr: '', exitCode: -1,
        timedOut: false, truncated: false, aborted: true,
      });
      return;
    }

    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...command.environment },
      windowsHide: true,
      // POSIX 使用独立进程组, 终止时先发 SIGTERM, 必要时再发 SIGKILL, 不只停止包装进程.
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let stdoutChars = 0;
    let stderrChars = 0;
    let timedOut = false;
    let stopped = false;
    let settled = false;

    // 多字节字符(如中文)可能被切在两个 chunk 边界: 按块 toString 会碎成 �,
    // StringDecoder 把不完整的尾部字节扣留到下一块拼齐, close 时 end() 收尾.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    // 原始输出由调用方保存为命令日志. 保存失败时停止命令, 等 close 后报告失败.
    // 等待退出期间仍读取管道, 但不再调用已经失败的日志写入函数.
    let outputError: Error | undefined;
    const emitOutput = (chunk: CommandOutputChunk): void => {
      if (onOutput === undefined || outputError !== undefined) return;
      try {
        onOutput(chunk);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputError = new Error(`Command output storage failed: ${message}`, { cause: error });
        clearTimeout(timeout);
        terminate();
      }
    };

    /**
     * Windows 同步请求 taskkill /T /F, POSIX 向整个进程组发送终止信号.
     * 终止命令本身可能失败; completion 仍以子进程 close/error 事件结束,
     * stop 返回不代表已经确认所有后代进程退出.
     */
    const terminateTree = (force: boolean): void => {
      if (process.platform === 'win32') {
        if (child.pid === undefined) return;
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          // 进程可能已经退出.
        }
        return;
      }
      try {
        process.kill(-child.pid!, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // 进程组已经退出.
      }
    };

    // 终止流程只进一次; 延迟强杀定时器在 close/error 时统一清除:
    // 进程提前退出后 PGID 可能被系统复用, 迟到的 SIGKILL 会误杀无关进程.
    let terminating = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const clearForceKillTimer = (): void => {
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
    };
    const terminate = (): void => {
      if (settled || terminating) return;
      terminating = true;
      terminateTree(false);
      // Windows 已请求强制终止; POSIX 才需要延迟发送 SIGKILL.
      if (process.platform !== 'win32') {
        forceKillTimer = setTimeout(() => terminateTree(true), FORCE_KILL_DELAY_MS);
        forceKillTimer.unref?.();
      }
    };
    stopProcess = (): void => {
      if (settled) return;
      stopped = true;
      clearTimeout(timeout);
      terminate();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref?.();

    const onAbort = (): void => {
      clearTimeout(timeout);
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      emitOutput({ stream: 'stdout', data: chunk });
      const text = stdoutDecoder.write(chunk);
      stdoutChars += text.length;
      stdout = appendBounded(stdout, text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      emitOutput({ stream: 'stderr', data: chunk });
      const text = stderrDecoder.write(chunk);
      stderrChars += text.length;
      stderr = appendBounded(stderr, text);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearForceKillTimer();
      signal?.removeEventListener('abort', onAbort);
      reject(outputError ?? error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearForceKillTimer();
      signal?.removeEventListener('abort', onAbort);

      if (outputError !== undefined) {
        reject(outputError);
        return;
      }

      // 收尾解码: 输出真在字符中间结束(进程被截断)时 end() 给出 U+FFFD, 如实呈现.
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail.length > 0) {
        stdoutChars += stdoutTail.length;
        stdout = appendBounded(stdout, stdoutTail);
      }
      const stderrTail = stderrDecoder.end();
      if (stderrTail.length > 0) {
        stderrChars += stderrTail.length;
        stderr = appendBounded(stderr, stderrTail);
      }

      const aborted = !timedOut && (stopped || (signal?.aborted ?? false));
      const truncated = stdoutChars > stdout.length || stderrChars > stderr.length;
      if (stdoutChars > stdout.length) {
        stdout = appendNoticeBounded(stdout, truncationNotice(stdoutChars));
      }
      if (stderrChars > stderr.length) {
        stderr = appendNoticeBounded(stderr, truncationNotice(stderrChars));
      }

      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? -1,
        timedOut,
        truncated,
        aborted,
      });
    });
  });
  return Object.freeze({
    completion,
    stop: () => stopProcess(),
  });
}

function appendBounded(current: string, incoming: string): string {
  const combined = current + incoming;
  if (combined.length <= MAX_STREAM_CHARS) return combined;

  const headChars = MAX_STREAM_CHARS / 2;
  const tailChars = MAX_STREAM_CHARS - headChars;
  return safeHead(combined, headChars) + safeTail(combined, tailChars);
}

/** 截断通知按流各自计数, 不报合并总数(读 stdout 的人不关心 stderr 的量). */
function truncationNotice(originalChars: number): string {
  return `\n[输出已截断: 原始 ${originalChars.toLocaleString()} 字符, 仅保留开头与结尾. 请缩小命令范围.]`;
}

/**
 * 通知也占用输出预算. 必要时从已保留文本的开头移除字符, 将通知放在末尾.
 */
function appendNoticeBounded(retained: string, notice: string): string {
  const combined = retained + notice;
  if (combined.length <= MAX_STREAM_CHARS) return combined;
  return safeTail(combined, MAX_STREAM_CHARS);
}

// 按 UTF-16 位置截断可能劈开 emoji 的代理对, 截断边界需要避开代理对中间.
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 取前 n 个 UTF-16 码元; 边界在代理对中间时少取一个. */
function safeHead(s: string, n: number): string {
  let end = Math.min(n, s.length);
  if (end > 0 && end < s.length && isHighSurrogate(s.charCodeAt(end - 1))) end -= 1;
  return s.slice(0, end);
}

/** 取后 n 个 UTF-16 码元; 边界在代理对中间时少取一个. */
function safeTail(s: string, n: number): string {
  let start = Math.max(0, s.length - n);
  if (start > 0 && isLowSurrogate(s.charCodeAt(start))) start += 1;
  return s.slice(start);
}
