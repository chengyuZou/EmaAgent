import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { CommandOutputChunk, CommandRunResult } from '@ema-agent/sandbox';
import { FOREGROUND_COMMAND_WAIT_MS, type BackgroundCommandResult } from '@ema-agent/tools';

export const FOREGROUND_COMMAND_WAIT_SECONDS = FOREGROUND_COMMAND_WAIT_MS / 1_000;

export const shellTimeoutSchema = z.number().int().min(1_000)
  .max(7 * 24 * 60 * 60 * 1_000).optional()
  .describe('Maximum total runtime in milliseconds, including foreground time. Defaults to the user setting and cannot exceed it.');

export const shellBackgroundSchema = z.boolean().optional()
  .describe(`Start in the background immediately instead of waiting up to ${FOREGROUND_COMMAND_WAIT_SECONDS} seconds.`);

export interface ShellCommandResult extends CommandRunResult {
  kind: 'commandResult';
  durationMs: number;
  /** Shell-specific exit-code interpretation or command safety information. */
  note?: string;
}

export type ShellProcessReference = Extract<BackgroundCommandResult, { kind: 'processReference' }>;
export type ShellResult = ShellCommandResult | ShellProcessReference;

export interface ShellProgress {
  stream: 'stdout' | 'stderr';
  text: string;
}

/** 后台转交后由 BackgroundProcess 关闭回调, 不再写入已返回的 Tool 进度通道. */
export function createShellOutputCallback(
  onProgress?: (progress: ShellProgress) => void,
): ((chunk: CommandOutputChunk) => void) | undefined {
  if (!onProgress) return undefined;
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  return chunk => {
    const decoder = chunk.stream === 'stdout' ? stdoutDecoder : stderrDecoder;
    const text = decoder.write(Buffer.from(chunk.data));
    if (text) onProgress({ stream: chunk.stream, text });
  };
}

export function shellProcessReferenceText(output: ShellProcessReference): string {
  return `Command is running in the background (id: ${output.backgroundProcessId}, status: ${output.status}).\n`
    + `Output so far: ${output.outputPreview}\n`
    + 'You will be notified when it completes; do not poll. To inspect progress, use ProcessOutput '
    + `or Read the logs in: ${output.outputRelativePath}`;
}
