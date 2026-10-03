// 通过真实 ZIP 和 SQLite 验证身份、多次 Run、fork 消息及外部归档关联校验.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AttachmentImagesRepo, Database, SessionBackupReader, SessionBackupRestorer,
  SubagentMessagesRepo, SubagentRunsRepo, SubagentsRepo,
} from '@ema-agent/storage';
import { createSessionExport } from '../export/sessionExport.js';
import { importSessionArchive } from '../import/sessionImport.js';
import {
  subagentMessageRecordSchema, subagentRecordSchema, subagentRunRecordSchema,
} from '../records/sessionRecords.js';

const roots: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  databases.splice(0).forEach(db => db.close());
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-backup-subagents-'));
  roots.push(root);
  return root;
}

function database(): Database {
  const db = new Database({ memory: true, kind: 'data' });
  databases.push(db);
  db.migrate();
  return db;
}

async function fixture() {
  const root = temporaryRoot();
  const sourceDir = path.join(root, 'source');
  const targetDir = path.join(root, 'target');
  const workDir = path.join(root, 'work');
  const db = database();
  db.sqlite.prepare(`INSERT INTO sessions (id, title, cwd, last_activity_at, created_at, updated_at)
    VALUES ('session', '子代理备份', 'D:/work', 1, 1, 1)`).run();
  const identities = new SubagentsRepo(db.sqlite);
  const runs = new SubagentRunsRepo(db.sqlite);
  const messages = new SubagentMessagesRepo(db.sqlite);
  for (const id of ['ordinary', 'fork', 'unfinished']) {
    identities.insert({ id, sessionId: 'session', title: id, description: `${id} 的委派`, createdAt: 10 });
    runs.insert({ id: `${id}-1`, subagentId: id, parentToolCallId: `${id}-call`,
      contextMode: id === 'fork' ? 'fork' : 'subagent', description: '首次执行', createdAt: 10 });
    runs.setRunConfiguration(`${id}-1`, {
      providerId: 'provider-a', modelId: 'model-a', protocol: 'openai-responses-llm',
      permissionMode: 'default', reasoningEffort: 'low',
    }, 11);
    if (id !== 'unfinished') {
      runs.completeRun(`${id}-1`, {
        iterations: 2, toolCallCount: 1, inputTokens: 100, outputTokens: 20, finalText: `${id} 第一轮`,
      }, 20);
    }
  }
  runs.startRun({ id: 'fork-2', subagentId: 'fork', parentToolCallId: 'continue-call',
    contextMode: 'fork', description: '追加任务', createdAt: 30 }, { title: '继续调查', description: '最终身份说明' });
  runs.setRunConfiguration('fork-2', {
    providerId: 'provider-b', modelId: 'model-b', protocol: 'anthropic-llm',
    permissionMode: 'acceptEdits', reasoningEffort: 'high',
  }, 31);
  runs.completeRun('fork-2', {
    iterations: 3, toolCallCount: 2, inputTokens: 200, outputTokens: 40, finalText: '第二轮完成',
  }, 40);

  const imagePath = path.join(sourceDir, 'sessions', 'session', 'attachments', 'images', 'fork.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  new AttachmentImagesRepo(db.sqlite).insertMany([{
    path: imagePath, session_id: 'session', name: 'fork.png', byte_size: 3, created_at: 1,
  }]);
  const inheritedBlocks = JSON.stringify([
    { type: 'image_reference', path: imagePath },
    { type: 'file_reference', path: 'D:/user/original.txt' },
  ]);
  messages.insertMany([
    { id: 'fork-user', subagentId: 'fork', runId: null, role: 'user', blocksJson: inheritedBlocks, createdAt: 1 },
    { id: 'fork-assistant', subagentId: 'fork', runId: null, role: 'assistant',
      blocksJson: JSON.stringify([{ type: 'text', text: '父历史' }]), createdAt: 2,
      providerId: 'parent-provider', modelId: 'parent-model', protocol: 'parent-protocol' },
    { id: 'fork-summary', subagentId: 'fork', runId: null, role: 'user', kind: 'summary',
      blocksJson: '"父摘要"', createdAt: 3, savedTokens: 50 },
    { id: 'fork-task', subagentId: 'fork', runId: 'fork-1', role: 'user', blocksJson: '"首次任务"', createdAt: 12 },
    { id: 'fork-output', subagentId: 'fork', runId: 'fork-1', role: 'assistant',
      blocksJson: JSON.stringify([{ type: 'tool_use', id: 'call-read', name: 'Read', args: { path: 'a.md' } }]), createdAt: 13 },
    { id: 'fork-result', subagentId: 'fork', runId: 'fork-1', role: 'user', kind: 'tool_results',
      blocksJson: JSON.stringify([{ type: 'tool_result', toolCallId: 'call-read', content: '内容',
        data: { path: 'a.md', lines: 2 }, durationMs: 1 }]), createdAt: 14 },
    { id: 'fork-next-task', subagentId: 'fork', runId: 'fork-2', role: 'user', blocksJson: '"追加任务"', createdAt: 32 },
    { id: 'fork-next-output', subagentId: 'fork', runId: 'fork-2', role: 'assistant',
      blocksJson: '"第二轮结果"', interrupted: true, createdAt: 33 },
    { id: 'fork-next-summary', subagentId: 'fork', runId: 'fork-2', role: 'user', kind: 'summary',
      blocksJson: '"子历史摘要"', summarizedThroughMessageId: 'fork-result', savedTokens: 75, createdAt: 34 },
    { id: 'fork-reminder', subagentId: 'fork', runId: 'fork-2', role: 'user', kind: 'reminder', blocksJson: '"提醒"', createdAt: 35 },
    { id: 'fork-continuation', subagentId: 'fork', runId: 'fork-2', role: 'user', kind: 'continuation', blocksJson: '"继续"', createdAt: 36 },
    { id: 'ordinary-task', subagentId: 'ordinary', runId: 'ordinary-1', role: 'user', blocksJson: '"普通委派"', createdAt: 12 },
  ]);
  const chunks: Buffer[] = [];
  await createSessionExport('session', sourceDir, workDir, new SessionBackupReader(db.sqlite))!.writeTo({
    write: async chunk => { chunks.push(Buffer.from(chunk)); },
    complete: async () => {},
    fail: async error => { throw error; },
  });
  const entries = unzipSync(Buffer.concat(chunks));
  const target = database();
  const restore = (bytes: Uint8Array) => importSessionArchive(
    { declaredBytes: bytes.byteLength, async *chunks() { yield bytes; } },
    targetDir, workDir, new SessionBackupReader(target.sqlite), new SessionBackupRestorer(target.sqlite), () => true,
  );
  return { db, target, targetDir, entries, restore };
}

describe('v7 子代理三表备份', () => {
  it('保留各 Run 的配置、原生消息、fork 来源与摘要关系, 未完成 Run 不恢复执行', async () => {
    const { db, target, targetDir, entries, restore } = await fixture();
    expect(JSON.parse(strFromU8(entries['manifest.json']!)).version).toBe(7);
    expect(entries['records/subagentInvocations.jsonl']).toBeUndefined();
    const identityRecords = strFromU8(entries['records/subagents.jsonl']!).trim().split('\n')
      .map(line => subagentRecordSchema.parse(JSON.parse(line)));
    expect(identityRecords.find(record => record.id === 'fork')).toMatchObject({
      title: '继续调查', description: '最终身份说明', providerId: 'provider-b',
      modelId: 'model-b', protocol: 'anthropic-llm', permissionMode: 'acceptEdits', reasoningEffort: 'high',
    });
    const runRecords = strFromU8(entries['records/subagentRuns.jsonl']!).trim().split('\n')
      .map(line => subagentRunRecordSchema.parse(JSON.parse(line)));
    expect(runRecords).toHaveLength(4);
    const archivedMessages = strFromU8(entries['records/subagentMessages.jsonl']!).trim().split('\n')
      .map(line => subagentMessageRecordSchema.parse(JSON.parse(line)));
    expect(archivedMessages.find(message => message.id === 'fork-output')).toMatchObject({
      runId: 'fork-1', providerId: null, modelId: null, protocol: null,
    });
    await restore(zipSync(entries));
    for (const id of ['ordinary', 'fork']) {
      expect(new SubagentsRepo(target.sqlite).findById(id)).toEqual(new SubagentsRepo(db.sqlite).findById(id));
    }
    for (const id of ['ordinary-1', 'fork-1', 'fork-2']) {
      expect(new SubagentRunsRepo(target.sqlite).findById(id)).toEqual(new SubagentRunsRepo(db.sqlite).findById(id));
    }
    expect(new SubagentsRepo(target.sqlite).findById('unfinished')?.status).toBe('cancelled');
    expect(new SubagentRunsRepo(target.sqlite).findById('unfinished-1')).toMatchObject({
      status: 'cancelled', completed_at: expect.any(Number), error: expect.stringContaining('不会继续执行'),
    });
    expect(new SubagentRunsRepo(target.sqlite).listRunningRuns()).toEqual([]);
    const messages = new SubagentMessagesRepo(target.sqlite);
    const all = messages.listAllForSubagent('fork');
    expect(all.find(message => message.id === 'fork-assistant')).toMatchObject({
      run_id: null, provider_id: 'parent-provider', model_id: 'parent-model', protocol: 'parent-protocol',
    });
    expect(all.find(message => message.id === 'fork-output')).toMatchObject({ provider_id: 'provider-a', model_id: 'model-a' });
    expect(all.find(message => message.id === 'fork-next-output')).toMatchObject({
      provider_id: 'provider-b', model_id: 'model-b', interrupted: 1,
    });
    for (const original of new SubagentMessagesRepo(db.sqlite).listAllForSubagent('fork')) {
      if (original.id === 'fork-user') continue;
      expect(all.find(message => message.id === original.id)).toEqual(original);
    }
    expect(messages.listForSubagentFromSummary('fork').map(message => message.id)).toEqual([
      'fork-next-summary', 'fork-next-task', 'fork-next-output', 'fork-reminder', 'fork-continuation',
    ]);
    const newPath = path.join(targetDir, 'sessions', 'session', 'attachments', 'images', 'fork.png');
    expect(JSON.parse(all.find(message => message.id === 'fork-user')!.blocks_json)).toEqual([
      { type: 'image_reference', path: newPath }, { type: 'file_reference', path: 'D:/user/original.txt' },
    ]);
    expect(fs.readFileSync(newPath)).toEqual(Buffer.from([1, 2, 3]));
  });

  it.each(['run-child', 'message-child', 'missing-run', 'other-run', 'missing-summary', 'other-summary', 'future-summary', 'unknown-file'])(
    '拒绝错误关联 %s, 不发布文件或留下数据库行', async scenario => {
      const { target, targetDir, entries, restore } = await fixture();
      const runs = strFromU8(entries['records/subagentRuns.jsonl']!).trim().split('\n')
        .map(line => subagentRunRecordSchema.parse(JSON.parse(line)));
      const messages = strFromU8(entries['records/subagentMessages.jsonl']!).trim().split('\n')
        .map(line => subagentMessageRecordSchema.parse(JSON.parse(line)));
      const output = messages.find(message => message.id === 'fork-output')!;
      const summary = messages.find(message => message.id === 'fork-next-summary')!;
      switch (scenario) {
        case 'run-child': runs[0]!.subagentId = 'missing'; break;
        case 'message-child': output.subagentId = 'missing'; break;
        case 'missing-run': output.runId = 'missing'; break;
        case 'other-run': output.runId = 'ordinary-1'; break;
        case 'missing-summary': summary.summarizedThroughMessageId = 'missing'; break;
        case 'other-summary': summary.summarizedThroughMessageId = 'ordinary-task'; break;
        case 'future-summary': summary.summarizedThroughMessageId = 'fork-reminder'; break;
        case 'unknown-file': entries['records/unknown.jsonl'] = strToU8(''); break;
      }
      entries['records/subagentRuns.jsonl'] = strToU8(runs.map(record => JSON.stringify(record)).join('\n'));
      entries['records/subagentMessages.jsonl'] = strToU8(messages.map(record => JSON.stringify(record)).join('\n'));
      await expect(restore(zipSync(entries))).rejects.toMatchObject({ code: 'invalid_format' });
      expect(target.sqlite.prepare('SELECT id FROM sessions').all()).toEqual([]);
      expect(fs.existsSync(path.join(targetDir, 'sessions', 'session'))).toBe(false);
    },
  );
});
