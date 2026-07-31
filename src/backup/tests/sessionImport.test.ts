// 验证当前 Session ZIP 的完整性校验、执行状态冻结、单事务恢复和文件路径身份约束。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Database,
  SessionBackupRestorer,
} from '@ema-agent/storage';
import { BACKUP_LIMITS } from '../limits.js';
import { exportPreparedSession } from '../export/sessionExport.js';
import { importSession } from '../import/sessionImport.js';
import { encodeJsonlLine } from '../records/jsonl.js';
import { BACKUP_RECORD_REGISTRY } from '../records/recordRegistry.js';
import type { SessionBackupManifest } from '../records/sessionRecords.js';
import type { BackupArchiveSource, BackupOutputSink } from '../types.js';

const roots: string[] = [];
const encoder = new TextEncoder();

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Session ZIP 导入', () => {
  it('把未完成执行冻结后在一个 data.db 事务中恢复', async () => {
    const archive = await buildArchive({
      turns: [{
        id: 'turn-1', sessionId: 'session-1', triggerType: 'userMessage',
        executionProfile: 'work', narrativePolicy: 'auto', status: 'running',
        userInput: '继续', startedAt: 10, completedAt: null, errorCode: null,
        errorMessage: null, iterations: 1, usageInputTokens: 2, usageOutputTokens: 3,
      }],
      tasks: [{
        id: 'task-1', sessionId: 'session-1', displayNumber: 1, subject: '任务',
        description: '待完成任务', activeForm: null, status: 'in_progress',
        createdByTurnId: 'turn-1', completedByTurnId: null, version: 0,
        createdAt: 11, updatedAt: 11, completedAt: null,
      }],
      agentRuns: [{
        id: 'run-1', sessionId: 'session-1', parentTurnId: 'turn-1',
        parentAgentRunId: null, taskId: 'task-1', kind: 'subagent', purpose: '检查',
        providerConfigId: null, modelId: null, status: 'running', error: null,
        iterations: 1, toolCallCount: 1, inputTokens: 1, outputTokens: 1,
        outputExcerpt: null, version: 0, createdAt: 12, updatedAt: 12, completedAt: null,
      }],
      toolExecutions: [{
        callId: 'call-1', sessionId: 'session-1', turnId: 'turn-1',
        agentRunId: 'run-1', toolName: 'Bash', inputJson: '{}', inputDigest: 'digest',
        status: 'running', resultPreview: null, errorCode: null, errorMessage: null,
        startedAt: 13, completedAt: null, version: 0, createdAt: 13, updatedAt: 13,
      }],
      backgroundProcesses: [{
        id: 'process-1', sessionId: 'session-1', originTurnId: 'turn-1',
        toolCallId: 'call-1', command: 'sleep 100', description: null, cwd: '/old',
        status: 'running', timeoutMs: 100_000, version: 0, createdAt: 14,
        startedAt: 14, completedAt: null, exitCode: null, terminationReason: null,
        stdoutBytes: 0, stderrBytes: 0, outputTruncated: false,
        outputDirectoryPath: 'files/backgroundProcesses/process-1/',
        completionClaimedAt: null, continuationTurnId: null, modelNotifiedAt: null,
      }],
    });
    const root = tempRoot();
    const database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    try {
      const result = await importSession({
        source: sourceOf(archive),
        activeDataDir: root,
        restorer: new SessionBackupRestorer(database.sqlite),
        sessionExists: () => false,
        modelPreferenceExists: () => true,
        kbExists: () => true,
      });
      expect(result.sessionId).toBe('session-1');
      expect(database.sqlite.prepare('SELECT status FROM turns WHERE id = ?').pluck().get('turn-1')).toBe('aborted');
      expect(database.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').pluck().get('task-1')).toBe('pending');
      expect(database.sqlite.prepare('SELECT status FROM agent_runs WHERE id = ?').pluck().get('run-1')).toBe('cancelled');
      expect(database.sqlite.prepare('SELECT status FROM tool_executions WHERE call_id = ?').pluck().get('call-1')).toBe('outcome_unknown');
      expect(database.sqlite.prepare('SELECT status FROM background_processes WHERE id = ?').pluck().get('process-1')).toBe('interrupted');
    } finally {
      database.close();
    }
  });

  it('任何已列入完整性清单的记录被篡改都拒绝且不留下 Session 目录', async () => {
    const original = await buildArchive({});
    const entries = unzipSync(original);
    entries['records/session.json'] = encoder.encode('{"id":"tampered"}\n');
    const tampered = zipSync(entries);
    const root = tempRoot();
    const database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    try {
      await expect(importSession({
        source: sourceOf(tampered),
        activeDataDir: root,
        restorer: new SessionBackupRestorer(database.sqlite),
        sessionExists: () => false,
        modelPreferenceExists: () => true,
        kbExists: () => true,
      })).rejects.toMatchObject({ code: 'integrity_mismatch' });
      expect(fs.existsSync(path.join(root, 'sessions', 'session-1'))).toBe(false);
    } finally {
      database.close();
    }
  });
});

async function buildArchive(
  overrides: Partial<Record<string, readonly unknown[]>>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const sink: BackupOutputSink = {
    write: async chunk => { chunks.push(new Uint8Array(chunk)); },
    commit: async () => {},
    abort: async () => { chunks.length = 0; },
  };
  const manifest: SessionBackupManifest = {
    format: 'ema-session', version: 2, sessionId: 'session-1',
    exportedAt: 100, generator: 'test', warnings: [],
  };
  await exportPreparedSession({
    manifest,
    async *entries() {
      for (const definition of BACKUP_RECORD_REGISTRY) {
        if (definition.name === 'session') {
          yield bytesEntry(definition.archivePath, {
            id: 'session-1', title: '备份会话', sourceWorkspaceRoot: '/source',
            createdAt: 1, updatedAt: 2, lastActivityAt: 2, archivedAt: null,
            pinned: false, pinnedAt: null, groupLabel: null, parentSessionId: null,
            executionProfile: 'work', narrativePolicy: 'auto',
            preferredProviderConfigId: null, preferredModelId: null,
          });
          continue;
        }
        if (definition.encoding === 'json') continue;
        const rows = overrides[definition.name] ?? [];
        yield {
          path: definition.archivePath,
          async *chunks() {
            for (const row of rows) yield encodeJsonlLine(row);
          },
        };
      }
    },
  }, sink, BACKUP_LIMITS);
  return join(chunks);
}

function bytesEntry(entryPath: string, value: unknown) {
  const bytes = encoder.encode(`${JSON.stringify(value)}\n`);
  return {
    path: entryPath,
    declaredSize: bytes.byteLength,
    async *chunks() { yield bytes; },
  };
}

function sourceOf(bytes: Uint8Array): BackupArchiveSource {
  return {
    declaredSize: bytes.byteLength,
    async *chunks() {
      for (let offset = 0; offset < bytes.byteLength; offset += 97) {
        yield bytes.subarray(offset, Math.min(offset + 97, bytes.byteLength));
      }
    },
  };
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-backup-import-'));
  roots.push(root);
  return root;
}
