// Session FIFO 按交付顺序消费; 子代理实时消息按真实 ID 合并, 旧 Run 收尾不能覆盖新 Run.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentMessage, SubagentRun } from '@ema-agent/agent';
import type { PermissionRequiredEvent } from '@ema-agent/permission';
import { useSessionActivityStore } from '../src/stores/sessionActivity.js';
import { useSubagentStore } from '../src/stores/subagent.js';
import { useSessionPanelStore } from '../src/stores/sessionPanel.js';
import { collectSubagentMessages } from '../src/chat/sidePanel/tabs/subagents/subagentMessages.js';

vi.mock('../src/api/subagents.js', () => ({ subagentsApi: { get: vi.fn(async () => { throw new Error('不读取 HTTP'); }) } }));
vi.mock('../src/chat/messages/UIMessage.js', () => ({
  UIMessage: () => null,
  toolResultsForMessages: () => new Map(),
}));
vi.mock('../src/stores/theme.js', () => ({
  useThemeStore: () => '',
}));
vi.mock('@ema-agent/ui', () => ({ Button: () => null, Markdown: () => null, Spinner: () => null }));

function message(id: string, createdAt: number, text: string): SubagentMessage {
  return { id, subagentId: 'child', runId: 'run-1', role: 'assistant', kind: 'normal',
    blocks: [{ type: 'text', text }], createdAt, summarizedThroughMessageId: null };
}
function run(id: string, status: SubagentRun['status']): SubagentRun {
  return { id, subagentId: 'child', parentToolCallId: 'call', contextMode: 'subagent', description: '测试',
    providerId: 'p', modelId: 'm', protocol: 'openai-llm', permissionMode: 'default', reasoningEffort: 'high',
    status, error: null, iterations: 1, toolCallCount: 0, inputTokens: 1, outputTokens: 2, finalText: '结果',
    createdAt: 1, updatedAt: 2, completedAt: status === 'running' ? null : 2 };
}
function permission(id: string): PermissionRequiredEvent {
  return { type: 'permission_required', sessionId: 'session', turnId: 'old-turn', toolCallId: id,
    toolName: 'PowerShell', input: {}, reason: '确认', subagentId: 'child', runId: 'run-1' };
}
beforeEach(() => {
  useSessionActivityStore.setState({ bySession: new Map() });
  useSubagentStore.setState({ subagents: new Map(), runsById: new Map(), progressById: new Map(),
    streamingMessages: new Map(), openMessageIds: new Set(), toolReferences: new Map(), toolProgress: new Map() });
  useSessionPanelStore.setState({ layouts: {} });
});

describe('Session 交互消费', () => {
  it('浏览器时钟倒退也不重排 Permission/AskUser, 父 Turn 完成不清子批准', () => {
    const store = useSessionActivityStore.getState();
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(300).mockReturnValueOnce(100).mockReturnValueOnce(0);
    store.applyInteractionEvent('session', permission('first'));
    store.applyInteractionEvent('session', { type: 'ask_user_required', sessionId: 'session', turnId: 't', toolCallId: 'ask', questions: [] });
    store.applyInteractionEvent('session', permission('last'));
    store.setRunning('session', null);
    expect(useSessionActivityStore.getState().bySession.get('session')!.pendingInteractions.map(item => item.request.toolCallId))
      .toEqual(['first', 'ask', 'last']);
    store.applyInteractionEvent('session', { type: 'permission_resolved', sessionId: 'session', turnId: 'old-turn',
      toolCallId: 'first', subagentId: 'child', runId: 'run-1', decision: 'allow' });
    expect(useSessionActivityStore.getState().bySession.get('session')!.pendingInteractions[0]!.kind).toBe('askUser');
    clock.mockRestore();
  });
  it('初始 session_state 保持 Server FIFO 而非 createdAt 排序', () => {
    const a = { kind: 'permission' as const, createdAt: 20, toolCallId: 'a', request: permission('a') };
    const b = { kind: 'permission' as const, createdAt: 10, toolCallId: 'b', request: permission('b') };
    useSessionActivityStore.getState().replaceSessionState('session', null, [a, b], []);
    expect(useSessionActivityStore.getState().bySession.get('session')!.pendingInteractions).toEqual([a, b]);
  });
});
describe('子代理消息与 Run', () => {
  it('delta/闭合只更新一个真实消息 ID, 不清历史, 不接入旧窗口后的缺口', () => {
    const stored = message('same', 2, '一');
    const updated = message('same', 2, '一二');
    const latest = message('latest', 10, '下一次 Run');
    expect(collectSubagentMessages([stored], [updated, latest], false)).toEqual([updated]);
    expect(collectSubagentMessages([stored], [updated, latest], true)).toEqual([updated, latest]);
    expect(collectSubagentMessages([latest], [updated, latest], true)).toEqual([latest]);
    const state = useSubagentStore.getState();
    state.receiveEvent('session', { type: 'message_updated', subagentId: 'child', runId: 'run-1', message: stored, streaming: true });
    state.receiveEvent('session', { type: 'message_updated', subagentId: 'child', runId: 'run-1', message: updated, streaming: false });
    expect(useSubagentStore.getState().streamingMessages.get('child')).toEqual([updated]);
    expect(useSubagentStore.getState().openMessageIds.has('same')).toBe(false);
  });
  it('旧 Run 的迟到终态不清新 Run, 本次配置与结果按 RunId 独立保存', () => {
    const state = useSubagentStore.getState();
    state.receiveEvent('session', { type: 'subagent_started', subagentId: 'child', runId: 'run-2', parentToolCallId: 'call-2', startedAt: 10 });
    state.receiveEvent('session', { type: 'iteration_started', subagentId: 'child', runId: 'run-2', iteration: 1,
      continuesOutput: false, run: run('run-2', 'running') });
    state.receiveEvent('session', { type: 'subagent_completed', subagentId: 'child', runId: 'run-1', run: run('run-1', 'completed') });
    expect(useSubagentStore.getState().progressById.get('child')?.runId).toBe('run-2');
    expect(useSubagentStore.getState().runsById.get('run-2')?.modelId).toBe('m');
    expect(useSubagentStore.getState().runsById.get('run-1')?.finalText).toBe('结果');
  });
  it('同一个标签复用, 再打开另一子代理只改变身份导航', () => {
    const panel = useSessionPanelStore.getState();
    panel.openTab('session', {
      id: 'subagents',
      kind: 'subagents',
      subagentId: 'child',
    });
    panel.openTab('session', {
      id: 'subagents',
      kind: 'subagents',
      subagentId: 'other',
    });
    const layout = useSessionPanelStore.getState().layouts['session']!;
    expect(layout.tabOrder).toEqual(['subagents']);
    expect(layout.tabsById['subagents']).toMatchObject({ subagentId: 'other' });
  });
});
