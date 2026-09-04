// 测试 compactSession 全链：坑位互斥、前置拒绝、窗口截断、摘要落库游标、abort 原样、用量记账与目录投影。
import { describe, expect, it, vi } from 'vitest';
import {
  compactManualMinRatioSetting,
  createCompact,
  type CompactRequest,
  type CompactResult,
} from '@ema-agent/compact';
import type { CallLlm, LlmStreamEvent } from '@ema-agent/llm';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import {
  ActiveSessionRegistry,
  SessionBusyError,
  SessionStore,
} from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import { Database } from '@ema-agent/storage';
import { TurnStore } from '@ema-agent/turn';
import type { UsageRecord, UsageRecorder } from '@ema-agent/usage';
import {
  compactSession,
  listCommandDescriptors,
  type CommandCompactDeps,
} from '../index.js';

const PROVIDER_ID = 'test-provider';
const MODEL_ID = 'test-model';
/** 小窗口让触发线落在 8500（默认 bufferRatio 0.15），测试不必构造十几万 token 的历史。 */
const CONTEXT_WINDOW = 10_000;

function summaryLlm(text = '<summary>压缩后的工作摘要</summary>'): CallLlm {
  return async function* (): AsyncIterable<LlmStreamEvent> {
    yield { type: 'text_delta', blockIndex: 0, delta: text };
    yield { type: 'usage', inputTokens: 8_000, outputTokens: 200 };
    yield { type: 'done', stopReason: 'end_turn' };
  };
}

function fakeSettingsStore(overrides: Record<string, unknown> = {}): SettingsStore {
  return {
    get: (def: { key: string; defaultValue: unknown }) =>
      def.key in overrides ? overrides[def.key] : def.defaultValue,
  } as unknown as SettingsStore;
}

interface Fixture {
  deps: CommandCompactDeps;
  sessions: SessionStore;
  turns: TurnStore;
  activeSessions: ActiveSessionRegistry;
  usageRecords: UsageRecord[];
  sessionId: string;
}

function makeFixture(options: {
  withModel?: boolean;
  callLlm?: CallLlm;
  settingsOverrides?: Record<string, unknown>;
} = {}): Fixture {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  const sessions = new SessionStore({ db });
  const activeSessions = new ActiveSessionRegistry();
  const turns = new TurnStore({ db, activeSessions });
  const usageRecords: UsageRecord[] = [];
  const usageRecorder: UsageRecorder = {
    record: record => {
      usageRecords.push(record);
    },
  };

  const sessionId = sessions.createSession().id;
  if (options.withModel !== false) {
    sessions.patchSession(sessionId, { model: { providerId: PROVIDER_ID, modelId: MODEL_ID } });
  }

  const deps: CommandCompactDeps = {
    sessions,
    turns,
    activeSessions,
    providers: {
      resolveConnection: () => ({ protocol: 'openai-llm', baseUrl: 'http://localhost' }),
    } as unknown as Providers,
    providerModels: {
      get: () => ({
        capability: 'llm',
        contextWindow: CONTEXT_WINDOW,
        maxOutput: null,
        inputImage: false,
      }),
    } as unknown as ProviderModels,
    attachments: { getMany: () => new Map() } as unknown as CommandCompactDeps['attachments'],
    settings: fakeSettingsStore(options.settingsOverrides),
    characterPrompt: () => ['你是测试角色'],
    skillEntries: async () => [],
    disabledSkillPaths: () => [],
    createCompact,
    createLlmCall: () => options.callLlm ?? summaryLlm(),
    usageRecorder,
  };
  return { deps, sessions, turns, activeSessions, usageRecords, sessionId };
}

/** 写入超过触发线的长历史（6 条 × 2 万字符，约 3 万 token > 窗口本身，同时触发窗口截断）。 */
function seedLongHistory(sessions: SessionStore, sessionId: string): string[] {
  const ids: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const message = sessions.appendMessage({
      turnId: null,
      sessionId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      blocks: `第${index}条 ${'长'.repeat(20_000)}`,
    });
    ids.push(message.id);
  }
  return ids;
}

describe('compactSession', () => {
  it('根 Turn 占用坑位时拒绝（SessionBusyError）', async () => {
    const { deps, turns, sessionId } = makeFixture();
    turns.startTurn({
      sessionId,
      triggerType: 'userMessage',
      executionProfile: 'chat',
      narrativePolicy: 'off',
    });
    await expect(compactSession(deps, sessionId)).rejects.toBeInstanceOf(SessionBusyError);
  });

  it('Session 未配置模型时拒绝 provider/not_configured', async () => {
    const { deps, sessionId } = makeFixture({ withModel: false });
    await expect(compactSession(deps, sessionId)).rejects.toMatchObject({
      name: 'CommandsError',
      code: 'provider/not_configured',
    });
  });

  it('空历史拒绝 nothing_to_compact', async () => {
    const { deps, sessionId } = makeFixture();
    await expect(compactSession(deps, sessionId)).rejects.toMatchObject({
      name: 'CommandsError',
      code: 'nothing_to_compact',
    });
  });

  it('估算低于触发线拒绝 compact_below_threshold，且不调用压缩', async () => {
    const fixture = makeFixture();
    const createCompactSpy = vi.fn(createCompact);
    fixture.sessions.appendMessage({
      turnId: null,
      sessionId: fixture.sessionId,
      role: 'user',
      blocks: '短消息',
    });
    await expect(compactSession(
      { ...fixture.deps, createCompact: createCompactSpy },
      fixture.sessionId,
    )).rejects.toMatchObject({
      name: 'CommandsError',
      code: 'compact_below_threshold',
    });
    expect(createCompactSpy).not.toHaveBeenCalled();
  });

  it('全部历史都在近期保留范围内时拒绝 nothing_to_compact', async () => {
    // 窗口 10k：近期保留线 1600，手动下限压到 100；约 500 tokens 的历史过下限但全在保留线内。
    const fixture = makeFixture({
      settingsOverrides: { [compactManualMinRatioSetting.key]: 0.01 },
    });
    fixture.sessions.appendMessage({
      turnId: null,
      sessionId: fixture.sessionId,
      role: 'user',
      blocks: 'a'.repeat(2_000),
    });
    await expect(compactSession(fixture.deps, fixture.sessionId)).rejects.toMatchObject({
      name: 'CommandsError',
      code: 'nothing_to_compact',
    });
  });

  it('成功压缩：窗口截断显式计数、摘要落库、尾部续读、记录用量', async () => {
    const { deps, sessions, usageRecords, sessionId } = makeFixture();
    const ids = seedLongHistory(sessions, sessionId);

    const result = await compactSession(deps, sessionId);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.contextWindow).toBe(CONTEXT_WINDOW);
    expect(result.beforeTokens).toBeGreaterThan(8_500);
    expect(result.savedTokens).toBeGreaterThan(0);
    // 历史（约 3 万 token）超过 1 万窗口：截断事件发生且计数进响应。
    expect(result.truncatedMessageCount).toBeGreaterThan(0);
    expect(result.truncatedTokens).toBeGreaterThan(0);

    const history = sessions.loadHistory(sessionId);
    const summary = history[0]!;
    expect(summary.kind).toBe('summary');
    expect(summary.blocks).toContain('压缩后的工作摘要');
    // 游标之后的尾部是原始历史的后缀（覆盖游标把被丢弃与被摘要消息一并切出可见历史）。
    const tailIds = history.slice(1).map(message => message.id);
    expect(tailIds.length).toBeLessThan(ids.length);
    expect(tailIds).toEqual(ids.slice(ids.length - tailIds.length));

    expect(usageRecords).toHaveLength(1);
    const record = usageRecords[0]!;
    expect(record.capability).toBe('llm');
    expect(record.providerId).toBe(PROVIDER_ID);
    expect(record.modelId).toBe(MODEL_ID);
    expect(record.sessionId).toBe(sessionId);
    expect(record.id).toMatch(/^compact:/);
    expect(record.inputTokens).toBe(8_000);
  });

  it('摘要请求形状：tools 为空、force、thinking 缺省、system 段含角色 Prompt', async () => {
    const fixture = makeFixture();
    const ids = seedLongHistory(fixture.sessions, fixture.sessionId);
    let captured: CompactRequest | undefined;
    const capturingCompact = () => async (request: CompactRequest): Promise<CompactResult> => {
      captured = request;
      request.saveMacroSummary?.('摘要正文', 1);
      return {
        kind: 'macro',
        history: request.history,
        beforeTokens: 9_000,
        afterTokens: 3_000,
        savedTokens: 6_000,
        durationMs: 5,
        usage: { inputTokens: 100, outputTokens: 20 },
        summarizedMessageCount: 1,
        droppedMessageCount: 0,
        droppedTokens: 0,
      };
    };

    const result = await compactSession(
      { ...fixture.deps, createCompact: capturingCompact },
      fixture.sessionId,
    );

    expect(result).toMatchObject({
      status: 'completed',
      contextWindow: CONTEXT_WINDOW,
      savedTokens: 6_000,
    });
    expect(captured?.tools).toEqual([]);
    expect(captured?.force).toBe(true);
    expect(captured?.micro).toBe(false);
    expect(captured?.thinking).toBeUndefined();
    expect(captured?.systemMessages.length).toBeGreaterThan(0);
    expect(captured?.systemMessages.every(message => message.role === 'system')).toBe(true);
    expect(
      captured?.systemMessages.map(message => message.content).join('\n'),
    ).toContain('你是测试角色');

    // summarizedMessageCount=1 → 覆盖游标指向第一条，其后五条原样续读。
    const history = fixture.sessions.loadHistory(fixture.sessionId);
    expect(history[0]!.kind).toBe('summary');
    expect(history.slice(1).map(message => message.id)).toEqual(ids.slice(1));
  });

  it('abort：历史原样（无摘要落库），返回 cancelled 且坑位释放', async () => {
    const hangingLlm: CallLlm = request => (async function* (): AsyncIterable<LlmStreamEvent> {
      await new Promise((_, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    })();
    const { deps, sessions, activeSessions, sessionId } = makeFixture({ callLlm: hangingLlm });
    const ids = seedLongHistory(sessions, sessionId);

    const pending = compactSession(deps, sessionId);
    await new Promise(resolve => setImmediate(resolve));
    const active = activeSessions.getActiveExecution(sessionId);
    expect(active?.kind).toBe('compact');
    activeSessions.abort(sessionId, active!.executionId);

    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(activeSessions.isRunning(sessionId)).toBe(false);
    expect(sessions.loadHistory(sessionId).map(message => message.id)).toEqual(ids);
  });
});

describe('listCommandDescriptors', () => {
  it('V1 只有 compact 一条确定性命令', () => {
    expect(listCommandDescriptors()).toEqual([{
      name: 'compact',
      description: expect.stringContaining('压缩'),
    }]);
  });
});
