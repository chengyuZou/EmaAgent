// 验证 fork 固定前缀、摘要映射、Run 消息流、原生来源和恢复归属.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, SubagentMessagesRepo, SubagentsRepo, SubagentRunsRepo } from '@ema-agent/storage';
import { SubagentMessagesStore } from '../subagents/subagentMessagesStore.js';
import type { ForkParentMessages } from '../subagents/types.js';

describe('SubagentMessagesStore', () => {
  let database: Database;
  let repo: SubagentMessagesRepo;
  let store: SubagentMessagesStore;
  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    database.sqlite.prepare("INSERT INTO sessions (id,title,cwd,created_at,updated_at) VALUES ('s','会话','',1,1)").run();
    new SubagentsRepo(database.sqlite).insert({ id: 'child', sessionId: 's', title: '标题', description: '描述', createdAt: 1 });
    const runs = new SubagentRunsRepo(database.sqlite);
    runs.insert({ id: 'r1', subagentId: 'child', contextMode: 'fork', createdAt: 1 });
    runs.setRunConfiguration('r1', {
      providerId: 'child-p', modelId: 'child-m', protocol: 'openai-chat', permissionMode: 'default', reasoningEffort: 'high',
    }, 2);
    repo = new SubagentMessagesRepo(database.sqlite);
    store = new SubagentMessagesStore(repo);
  });
  afterEach(() => database.close());

  function parent(): ForkParentMessages {
    return { messages: [
      { id: 'summary', role: 'user', kind: 'summary', blocks: '摘要 S', interrupted: false, createdAt: 2,
        summarizedThroughMessageId: 'outside', savedTokens: 30 },
      { id: 'user', role: 'user', kind: 'normal', blocks: '剩余消息', interrupted: false, createdAt: 3, summarizedThroughMessageId: null },
      { id: 'assistant', role: 'assistant', kind: 'normal', interrupted: false, createdAt: 4, summarizedThroughMessageId: null,
        generatedBy: { providerId: 'parent-p', modelId: 'parent-m', protocol: 'anthropic' },
        blocks: [{ type: 'thinking', thinking: '推理', signature: '签名' },
          { type: 'tool_use', id: 'parent-call', name: 'Subagent', args: {} }] },
    ] };
  }

  it('范围外覆盖 ID 清空但摘要入库; 新 ID、父来源和工具占位只在副本中', () => {
    const source = parent();
    const original = JSON.stringify(source);
    store.initialize('child', 'r1', '  实际任务\n原文  ', source);
    const all = repo.listAllForSubagent('child');
    expect(all).toHaveLength(6);
    expect(all[0]).toMatchObject({ kind: 'summary', run_id: null, summarized_through_message_id: null, summary_saved_tokens: 30 });
    expect(store.loadHistory('child')).toHaveLength(6);
    expect(all.map(m => m.id)).not.toContain('assistant');
    expect(all[2]).toMatchObject({ provider_id: 'parent-p', model_id: 'parent-m', protocol: 'anthropic', run_id: null });
    expect(JSON.parse(all[3]!.blocks_json)).toMatchObject([{ toolCallId: 'parent-call', type: 'tool_result' }]);
    expect(all.at(-1)).toMatchObject({ run_id: 'r1', blocks_json: JSON.stringify('  实际任务\n原文  ') });
    expect(new Set(all.map(m => m.created_at)).size).toBe(all.length);
    expect(JSON.stringify(source)).toBe(original);
    expect(store.findToolInteraction('child', 'parent-call')).toBeUndefined();
  });

  it('覆盖消息在范围内则映射, 不保留父 Message ID', () => {
    const source = parent();
    const messages = [source.messages[1]!, { ...source.messages[0]!, summarizedThroughMessageId: 'user' }, source.messages[2]!];
    store.initialize('child', 'r1', '任务', { messages });
    const all = repo.listAllForSubagent('child');
    expect(all[1]!.summarized_through_message_id).toBe(all[0]!.id);
    expect(store.loadHistory('child').map(m => m.kind)).toEqual(['summary', 'normal', 'tool_results', 'reminder', 'normal']);
  });

  it('流式内容完整保存, tool_use 先落库; 闭合沿用同一 ID 并保留原生状态', () => {
    store.record('child', 'r1', { type: 'text_delta', blockIndex: 0, delta: '读取' });
    store.record('child', 'r1', { type: 'tool_use_completed', blockIndex: 2, toolCallId: 'tool1', toolName: 'Read', args: { path: 'a' } });
    const id = repo.listAllForSubagent('child')[0]!.id;
    expect(store.findToolInteraction('child', 'tool1')).toEqual({ runId: 'r1', name: 'Read', args: { path: 'a' } });
    const blocks = [{ type: 'text' as const, text: '读取' }, { type: 'reasoning' as const, id: 'native', encryptedContent: 'opaque' },
      { type: 'tool_use' as const, id: 'tool1', name: 'Read', args: { path: 'a' } }];
    expect(store.record('child', 'r1', {
      type: 'assistant_message_completed', iteration: 1, llmCallId: 'llm', stopReason: 'tool_use', content: blocks,
    })).toBe(id);
    const result = { type: 'tool_result' as const, toolCallId: 'tool1', content: '结果', durationMs: 12 };
    store.appendToolResult('child', 'r1', result);
    expect(store.listPage('child', undefined, 50).items[0]).toMatchObject({
      id, runId: 'r1', blocks, generatedBy: { providerId: 'child-p', modelId: 'child-m', protocol: 'openai-chat' },
    });
    expect(database.sqlite.prepare('SELECT provider_id,model_id,protocol FROM subagent_messages WHERE id=?').get(id))
      .toEqual({ provider_id: null, model_id: null, protocol: null });
    expect(store.findToolInteraction('child', 'tool1')?.result).toEqual(result);
  });

  it('断流保存已产生的正文并标中断; 分页使用时间和 ID 游标', () => {
    store.record('child', 'r1', { type: 'text_delta', blockIndex: 0, delta: '未完成' });
    store.interruptActiveAssistant('r1');
    store.appendToolResult('child', 'r1', { type: 'tool_result', toolCallId: 'x', content: '结果' });
    const page = store.listPage('child', undefined, 1);
    expect(page.nextCursor).toEqual({ createdAt: expect.any(Number), id: expect.any(String) });
    expect(store.listPage('child', page.nextCursor!, 1).items[0]).toMatchObject({ interrupted: true, blocks: [{ type: 'text', text: '未完成' }] });
  });

  it('自身摘要保存覆盖边界与 savedTokens, 新 Store 仍恢复有效历史', () => {
    store.initialize('child', 'r1', '首个任务');
    const through = store.loadHistory('child').at(-1)!.id;
    const summary = store.appendSummary('child', 'r1', '阶段摘要', through, 50);
    store.appendToolResult('child', 'r1', { type: 'tool_result', toolCallId: 'x', content: '后续' });
    expect(new SubagentMessagesStore(repo).loadHistory('child')).toMatchObject([
      { id: summary.id, kind: 'summary', savedTokens: 50 }, { kind: 'tool_results' },
    ]);
  });
});
