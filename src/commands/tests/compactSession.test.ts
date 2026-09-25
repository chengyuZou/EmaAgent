// 测试 compactSession 全链: Session 运行互斥、前置拒绝、分段摘要、落库游标、abort 原样、用量记账与目录投影.
import { describe, expect, it, vi } from 'vitest';
import {
  compactManualMinRatioSetting,
  createCompact,
  type CompactEvent,
  type CompactRequest,
  type CompactResult,
} from '@ema-agent/compact';
import type { CallLlm, LlmStreamEvent } from '@ema-agent/llm';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import {
  SessionRunningRegistry,
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
  type ManualCompactDeps,
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
  deps: ManualCompactDeps;
  sessions: SessionStore;
  turns: TurnStore;
  sessionRunning: SessionRunningRegistry;
  usageRecords: UsageRecord[];
  compactEvents: CompactEvent[];
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
  const sessionRunning = new SessionRunningRegistry();
  const turns = new TurnStore({ db, sessionRunning });
  const usageRecords: UsageRecord[] = [];
  const compactEvents: CompactEvent[] = [];
  const usageRecorder: UsageRecorder = {
    record: record => {
      usageRecords.push(record);
    },
  };

  const sessionId = sessions.createSession().id;
  if (options.withModel !== false) {
    sessions.patchSession(sessionId, { providerId: PROVIDER_ID, modelId: MODEL_ID });
  }

  const deps: ManualCompactDeps = {
    sessions,
    turns,
    sessionRunning,
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
    settings: fakeSettingsStore(options.settingsOverrides),
    characterPrompt: () => ['你是测试角色'],
    skillEntries: async () => [],
    disabledSkillPaths: () => [],
    createCompact,
    createLlmCall: () => options.callLlm ?? summaryLlm(),
    usageRecorder,
    emit: event => compactEvents.push(event),
  };
  return { deps, sessions, turns, sessionRunning, usageRecords, compactEvents, sessionId };
}

/** 写入超过触发线的长历史(6 条 × 2 万字符, 约 3 万 token > 窗口本身). */
function seedLongHistory(sessions: SessionStore, sessionId: string): string[] {
  const ids: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const text = `第${index}条 ${'长'.repeat(20_000)}`;
    const message = sessions.appendMessage({
      turnId: null,
      sessionId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      blocks: index % 2 === 0 ? text : [{ type: 'text', text }],
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
      sessionMode: 'chat',
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

  it('成功压缩: 超窗历史分段摘要、落库、尾部续读、记录用量', async () => {
    let summaryCalls = 0;
    const requestedMessages: string[] = [];
    const callLlm: CallLlm = request => {
      summaryCalls += 1;
      requestedMessages.push(JSON.stringify(request.messages));
      return summaryLlm()(request);
    };
    const { deps, sessions, usageRecords, compactEvents, sessionId } = makeFixture({ callLlm });
    const ids = seedLongHistory(sessions, sessionId);

    const result = await compactSession(deps, sessionId);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.contextWindow).toBe(CONTEXT_WINDOW);
    expect(result.beforeTokens).toBeGreaterThan(8_500);
    expect(result.savedTokens).toBeGreaterThan(0);
    // 原始历史超过单次窗口, 所有旧消息仍经多次摘要调用处理.
    expect(summaryCalls).toBeGreaterThan(1);
    for (let index = 0; index < ids.length; index += 1) {
      expect(requestedMessages.some(messages => messages.includes(`第${index}条 `))).toBe(true);
    }

    const history = sessions.loadHistory(sessionId);
    const summary = history[0]!;
    expect(summary.kind).toBe('summary');
    expect(summary.turnId).toBeNull();
    expect(summary.blocks).toContain('压缩后的工作摘要');
    // 游标之后的尾部是原始历史的后缀; 游标之前的消息已进入摘要.
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
    expect(record.inputTokens).toBe(8_000 * summaryCalls);
    expect(compactEvents.map(event => event.type)).toEqual(['compact_started', 'compact_completed']);
  });

  it('项目 Work Session 压缩时使用项目身份装载技能目录', async () => {
    const fixture = makeFixture();
    const project = fixture.sessions.createProject(
      'Demo',
      ['D:/main', 'D:/other'],
      'D:/main',
    );
    const projectSessionId = fixture.sessions.createSession({ projectId: project.id }).id;
    fixture.sessions.patchSession(projectSessionId, {
      sessionMode: 'work',
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
    });
    seedLongHistory(fixture.sessions, projectSessionId);
    const requested: Array<[string, string | null]> = [];

    const result = await compactSession({
      ...fixture.deps,
      skillEntries: async (cwd, projectId) => {
        requested.push([cwd, projectId]);
        return [];
      },
    }, projectSessionId);

    expect(result.status).toBe('completed');
    expect(requested).toEqual([['D:/main', project.id]]);
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
        messages: request.messages,
        beforeTokens: 9_000,
        afterTokens: 3_000,
        savedTokens: 6_000,
        durationMs: 5,
        usage: { inputTokens: 100, outputTokens: 20 },
        summarizedMessageCount: 1,
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
    const { deps, sessions, sessionRunning, compactEvents, sessionId } = makeFixture({ callLlm: hangingLlm });
    const ids = seedLongHistory(sessions, sessionId);

    const pending = compactSession(deps, sessionId);
    await new Promise(resolve => setImmediate(resolve));
    const running = sessionRunning.getRunning(sessionId);
    expect(running?.kind).toBe('compact');
    sessionRunning.abort(sessionId, running!);

    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(sessionRunning.isRunning(sessionId)).toBe(false);
    expect(sessions.loadHistory(sessionId).map(message => message.id)).toEqual(ids);
    expect(compactEvents.map(event => event.type)).toEqual([
      'compact_started',
      'compact_cancelled',
    ]);
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
