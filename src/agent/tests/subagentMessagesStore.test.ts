// 验证子代理完整 Message 的写入、回放和工具结果恢复。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, SubagentMessagesRepo, SubagentsRepo } from '@ema-agent/storage';
import { SubagentMessagesStore } from '../subagents/subagentMessagesStore.js';

describe('SubagentMessagesStore', () => {
  let database: Database;
  let repo: SubagentMessagesRepo;
  let store: SubagentMessagesStore;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    database.sqlite.prepare(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
      VALUES ('session-1', 'Session', 'D:/work', 1, 1)
    `).run();
    database.sqlite.prepare(`
      INSERT INTO turns (id, session_id, status, created_at)
      VALUES ('turn-1', 'session-1', 'running', 1)
    `).run();
    new SubagentsRepo(database.sqlite).insert({
      id: 'subagent-1',
      toolCallId: 'call-subagent-1',
      sessionId: 'session-1',
      contextMode: 'subagent',
      createdAt: 1,
    });
    repo = new SubagentMessagesRepo(database.sqlite);
    store = new SubagentMessagesStore(repo);
  });

  afterEach(() => database.close());

  it('tool_use 完成即落调用事实, Assistant 闭合后补全同一条 Message', () => {
    store.record('subagent-1', {
      type: 'tool_use_completed',
      blockIndex: 2,
      toolCallId: 'tool-1',
      toolName: 'Read',
      args: { path: 'a.ts' },
    });
    const partial = store.listPage('subagent-1', undefined, 50).items;
    expect(partial).toMatchObject([{
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Read', args: { path: 'a.ts' } }],
    }]);
    expect(store.findToolInteraction('subagent-1', 'tool-1')).toEqual({
      name: 'Read',
      args: { path: 'a.ts' },
    });

    store.record('subagent-1', {
      type: 'tool_use_completed',
      blockIndex: 3,
      toolCallId: 'tool-2',
      toolName: 'Glob',
      args: { pattern: '*.ts' },
    });
    const completedBlocks = [
      { type: 'text' as const, text: '检查项目.' },
      { type: 'tool_use' as const, id: 'tool-1', name: 'Read', args: { path: 'a.ts' } },
      { type: 'tool_use' as const, id: 'tool-2', name: 'Glob', args: { pattern: '*.ts' } },
    ];
    store.record('subagent-1', {
      type: 'assistant_message_completed',
      iteration: 1,
      llmCallId: 'call-1',
      stopReason: 'tool_use',
      content: completedBlocks,
    });

    const messages = store.listPage('subagent-1', undefined, 50).items;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: partial[0]!.id, blocks: completedBlocks });
  });

  it('模型流中断时保留已启动工具的调用事实并标记 Assistant 未闭合', () => {
    store.record('subagent-1', {
      type: 'tool_use_completed',
      blockIndex: 0,
      toolCallId: 'tool-1',
      toolName: 'Read',
      args: { path: 'a.ts' },
    });
    store.interruptActiveAssistant('subagent-1');

    expect(store.listPage('subagent-1', undefined, 50).items).toMatchObject([{
      role: 'assistant',
      interrupted: true,
      blocks: [{ type: 'tool_use', id: 'tool-1' }],
    }]);
  });

  it('完整 Assistant blocks 与 User ToolResult 分别落为一条 Message', () => {
    const assistantBlocks = [
      { type: 'reasoning' as const, id: 'reasoning-1', encryptedContent: 'opaque' },
      { type: 'text' as const, text: '先读取文件.' },
      { type: 'tool_use' as const, id: 'tool-1', name: 'Read', args: { path: 'a.ts' } },
    ];
    store.record('subagent-1', {
      type: 'assistant_message_completed',
      iteration: 1,
      llmCallId: 'call-1',
      stopReason: 'tool_use',
      content: assistantBlocks,
    });
    expect(store.findToolInteraction('subagent-1', 'tool-1')).toEqual({
      name: 'Read',
      args: { path: 'a.ts' },
    });

    const result = {
      type: 'tool_result' as const,
      toolCallId: 'tool-1',
      content: '文件内容',
      durationMs: 12,
    };
    store.record('subagent-1', { type: 'tool_result', result });
    store.record('subagent-1', {
      type: 'assistant_message_completed',
      iteration: 2,
      llmCallId: 'call-2',
      stopReason: 'end_turn',
      content: [{ type: 'gemini_thought', text: '完成', thoughtSignature: 'signature' }],
    });

    const page = store.listPage('subagent-1', undefined, 50);
    expect(page.items).toMatchObject([
      { role: 'assistant', kind: 'normal', blocks: assistantBlocks, sequence: 1 },
      { role: 'user', kind: 'tool_results', blocks: [result], sequence: 2 },
      {
        role: 'assistant', kind: 'normal',
        blocks: [{ type: 'gemini_thought', text: '完成', thoughtSignature: 'signature' }],
        sequence: 3,
      },
    ]);
    expect(page.nextCursor).toBeNull();
    expect(new Set(page.items.map(message => message.id)).size).toBe(3);
    expect(store.findToolInteraction('subagent-1', 'tool-1')).toEqual({
      name: 'Read',
      args: { path: 'a.ts' },
      result,
    });
  });

  it('回放 User 的 summary/reminder，恢复补写的工具结果仍可配对', () => {
    store.record('subagent-1', {
      type: 'assistant_message_completed',
      iteration: 1,
      llmCallId: 'call-1',
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', args: { path: 'a.ts' } }],
    });
    store.appendToolResult('subagent-1', {
      type: 'tool_result',
      toolCallId: 'tool-1',
      content: '恢复后的结果',
      isError: true,
    });
    const assistantId = repo.listAllForSubagent('subagent-1')[0]!.id;
    repo.insert({
      id: 'summary-1', subagentId: 'subagent-1', role: 'user', kind: 'summary',
      blocksJson: '"已完成读取"', summarizedThroughMessageId: assistantId, createdAt: 10,
    });
    repo.insert({
      id: 'reminder-1', subagentId: 'subagent-1', role: 'user', kind: 'reminder',
      blocksJson: '"父对话提醒"', createdAt: 11,
    });

    expect(store.listPage('subagent-1', undefined, 50).items.slice(2)).toMatchObject([
      { role: 'user', kind: 'summary', blocks: '已完成读取' },
      { role: 'user', kind: 'reminder', blocks: '父对话提醒' },
    ]);
    expect(store.findToolInteraction('subagent-1', 'tool-1')?.result).toMatchObject({
      content: '恢复后的结果',
      isError: true,
    });
  });
});
