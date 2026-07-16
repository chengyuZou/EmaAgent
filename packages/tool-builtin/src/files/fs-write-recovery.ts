// 这里根据中断的工具日志，只清理由对应 fs_write 调用留下的临时文件。
import fs from 'node:fs';
import path from 'node:path';
import type { ToolExecutionRecord } from '@ema-agent/contracts';
import { atomicTempPrefix, resolveAtomicTargetPath } from './atomic-write.js';

export interface FsWriteRecoveryResult {
  removed: string[];
  failed: Array<{ path: string; message: string }>;
}

export function cleanupInterruptedFsWriteTemps(
  executions: readonly ToolExecutionRecord[],
): FsWriteRecoveryResult {
  const result: FsWriteRecoveryResult = { removed: [], failed: [] };

  for (const execution of executions) {
    if (execution.toolName !== 'fs_write' || execution.status !== 'outcome_unknown') continue;
    const targetPath = readTargetPath(execution.inputJson);
    if (!targetPath) continue;

    let absoluteTarget: string;
    try {
      absoluteTarget = resolveAtomicTargetPath(targetPath, false);
    } catch (error) {
      result.failed.push({ path: targetPath, message: errorMessage(error) });
      continue;
    }
    const directory = path.dirname(absoluteTarget);
    const prefix = atomicTempPrefix(absoluteTarget, execution.callId);
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if (isMissingPath(error)) continue;
      result.failed.push({ path: directory, message: errorMessage(error) });
      continue;
    }

    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const tempPath = path.join(directory, name);
      try {
        const stat = fs.lstatSync(tempPath);
        if (!stat.isFile()) continue;
        fs.unlinkSync(tempPath);
        result.removed.push(tempPath);
      } catch (error) {
        result.failed.push({ path: tempPath, message: errorMessage(error) });
      }
    }
  }

  return result;
}

function readTargetPath(inputJson: string): string | undefined {
  try {
    const input = JSON.parse(inputJson) as unknown;
    if (typeof input !== 'object' || input === null) return undefined;
    const value = (input as Record<string, unknown>).file_path;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
