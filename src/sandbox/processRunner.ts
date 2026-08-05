// 启动沙箱包装后的子进程，并统一处理输出上限、超时和取消。
// 只执行 SandboxCommand: 不读取 process.env, 不理解 Sandbox Policy。

import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  CommandOutputChunk,
  CommandProcessHandle,
  CommandRunResult,
  SandboxCommand,
} from './types.js';

const MAX_OUTPUT_CHARS = 200_000;
const MAX_STREAM_CHARS = MAX_OUTPUT_CHARS / 2;
const FORCE_KILL_DELAY_MS = 3_000;

export function startProcess(
  command: SandboxCommand,
  timeoutMs: number,
  signal?: AbortSignal,
  onOutput?: (chunk: CommandOutputChunk) => void,
): CommandProcessHandle {
  let stopProcess = (): void => undefined;
  const completion = new Promise<CommandRunResult>((resolve, reject) => {
    // 已取消的 signal 不启动进程, 诚实返回取消结果而不是"先启动再杀"。
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
      // POSIX: 独立进程组, 终止时整组(SIGTERM→SIGKILL)而不是只杀包装进程。
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
    // StringDecoder 把不完整的尾部字节扣留到下一块拼齐, close 时 end() 收尾。
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    // onOutput 是外部注入的消费回调(日志落盘): 它抛错不该杀死命令本身——
    // 捕获后记一笔并停止转发, 命令继续跑完, 内存留存不受影响。
    let onOutputFailed = false;
    const emitOutput = (chunk: CommandOutputChunk): void => {
      if (onOutput === undefined || onOutputFailed) return;
      try {
        onOutput(chunk);
      } catch (error) {
        onOutputFailed = true;
        console.warn('[sandbox] onOutput 消费方抛错, 后续原始输出不再转发:', error);
      }
    };

    /**
     * 终止整棵进程树。Windows 无 POSIX 进程组: taskkill /T /F 是唯一真实的
     * 树终止(立即, 不伪装宽限期); spawnSync 会阻塞事件循环几十到几百毫秒,
     * 用它换"stop 返回时树已确认死亡"的确定性, 是知情取舍不是疏忽。
     * POSIX: 负 pid 打整个进程组, TERM 宽限后 KILL。
     */
    const terminateTree = (force: boolean): void => {
      if (process.platform === 'win32') {
        if (child.pid === undefined) return;
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          // 进程可能已经退出。
        }
        return;
      }
      try {
        process.kill(-child.pid!, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // 进程组已经退出。
      }
    };

    // 终止流程只进一次; 延迟强杀定时器在 close/error 时统一清除——
    // 进程提前退出后 PGID 可能被系统复用, 迟到的 SIGKILL 会误杀无关进程。
    let terminating = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const clearForceKillTimer = (): void => {
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
    };
    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      terminateTree(false);
      // Windows 的 taskkill /T /F 第一次已是强杀, 补枪定时器只服务 POSIX。
      if (process.platform !== 'win32') {
        forceKillTimer = setTimeout(() => terminateTree(true), FORCE_KILL_DELAY_MS);
        forceKillTimer.unref?.();
      }
    };
    stopProcess = (): void => {
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
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearForceKillTimer();
      signal?.removeEventListener('abort', onAbort);

      // 收尾解码: 输出真在字符中间结束(进程被截断)时 end() 给出 U+FFFD, 如实呈现。
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

/** 截断通知按流各自计数, 不报合并总数(读 stdout 的人不关心 stderr 的量)。 */
function truncationNotice(originalChars: number): string {
  return `\n[输出已截断：原始 ${originalChars.toLocaleString()} 字符，仅保留开头与结尾。请缩小命令范围。]`;
}

/**
 * 拼接截断通知且不破坏流上限: 超长时从保留窗口头部再弃等长字符,
 * 通知固定留在末尾(用户最先看到的位置)。
 */
function appendNoticeBounded(retained: string, notice: string): string {
  const combined = retained + notice;
  if (combined.length <= MAX_STREAM_CHARS) return combined;
  return safeTail(combined, MAX_STREAM_CHARS);
}

// 按 UTF-16 code unit 切割可能劈开代理对(emoji 等): 边界各退一步, 不留半个字符。
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 取前 n 个 code unit; 结尾若恰是高位代理则少取一个, 避免半截代理对。 */
function safeHead(s: string, n: number): string {
  let end = Math.min(n, s.length);
  if (end > 0 && end < s.length && isHighSurrogate(s.charCodeAt(end - 1))) end -= 1;
  return s.slice(0, end);
}

/** 取后 n 个 code unit; 开头若恰是低位代理则少取一个, 避免半截代理对。 */
function safeTail(s: string, n: number): string {
  let start = Math.max(0, s.length - n);
  if (start > 0 && isLowSurrogate(s.charCodeAt(start))) start += 1;
  return s.slice(start);
}
