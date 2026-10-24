import { readFileSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import type { CallEmbed } from '@ema-agent/embed';
import type { CompleteLLM, LLMCompletion } from '@ema-agent/llm';
import type { CallRerank } from '@ema-agent/rerank';
import { buildContext } from '../pipeline/context.js';
import { MAX_CONTEXT_CHARACTERS } from '../pipeline/constants.js';
import { buildKeywordExtractionPrompt, ROUTER_PROMPT } from '../pipeline/prompts.js';
import {
  NarrativeChunksRepo,
  NarrativeGraphRepo,
  type NarrativeTimelineId,
} from '@ema-agent/storage';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NarrativeSearch, type NarrativeRecallResult } from '../index.js';

const timelines: NarrativeTimelineId[] = ['1st_Loop', '2nd_Loop', '3rd_Loop'];
function routesFor(ids = timelines): string {
  return JSON.stringify({ timelines: ids });
}
let routerResponse: string;
let keywordResponse: string;
let db: BetterSqlite3.Database;
let chunks: NarrativeChunksRepo;
let search: NarrativeSearch;
function vector(first: number, second = 0, third = 0): number[] {
  const values = Array<number>(1024).fill(0);
  values[0] = first;
  values[1] = second;
  values[2] = third;
  return values;
}

function blob(values: number[]): Buffer {
  return Buffer.from(Float32Array.from(values).buffer);
}
function reply(text: string): LLMCompletion {
  const middle = Math.floor(text.length / 2);
  return {
    blocks: [
      { type: 'thinking', thinking: '这不是 JSON 结果' },
      { type: 'text', text: text.slice(0, middle) },
      { type: 'text', text: text.slice(middle) },
    ],
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
const completeLLM = vi.fn<CompleteLLM>(async request => reply(
  request.messages[0]?.content === ROUTER_PROMPT ? routerResponse : keywordResponse,
));
const callRerank = vi.fn<CallRerank>(async request => ({
  results: request.documents.slice(0, request.topK).map((_, index) => ({ index, score: 1 - index / 100 })),
}));
const callEmbed = vi.fn<CallEmbed>(async request => ({
  dim: 1024,
  embeddings: request.texts.map(text => {
    if (text === '人物') {
      return vector(0, 1);
    }
    if (text === '关系') {
      return vector(0, 0, 1);
    }
    return vector(1);
  }),
}));
function textOf(result: NarrativeRecallResult, timeline: NarrativeTimelineId): string {
  const value = result.get(timeline);
  if (!value || !('text' in value)) {
    throw new Error(`没有成功检索 ${timeline}`);
  }
  return value.text;
}

function contextRows(text: string): Array<{ entity?: string; entity1?: string; content?: string }> {
  return text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
}

beforeEach(() => {
  vi.clearAllMocks();
  routerResponse = routesFor();
  keywordResponse = JSON.stringify({ high_level_keywords: ['关系'], low_level_keywords: ['人物'] });
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  for (const name of ['narrative.sql']) {
    db.exec(readFileSync(new URL(`../../storage/migrations/narrative/${name}`, import.meta.url), 'utf8'));
  }
  const insertChunk = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
  const insertEntity = db.prepare('INSERT INTO entities VALUES (?, ?, ?, ?, ?)');
  const insertRelation = db.prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const timeline of timelines) {
    insertChunk.run(timeline, 'direct', `${timeline}:direct 原文\n结束`, blob(vector(1)));
    insertChunk.run(timeline, 'entity', `${timeline}:entity`, blob(vector(0.1, Math.sqrt(0.99))));
    insertChunk.run(timeline, 'relation', `${timeline}:relation`, blob(vector(0.05, 0, Math.sqrt(0.9975))));
    insertEntity.run(timeline, 'A', 'person', 'A 的背景', blob(vector(0, 1)));
    insertEntity.run(timeline, 'B', 'person', 'B 的背景', blob(vector(0, -1)));
    insertEntity.run(timeline, 'C', 'person', 'C 的背景', blob(vector(0, -1)));
    insertRelation.run(timeline, 1, 'A', 'B', 'AB', 1, blob(vector(0, 0, -1)));
    insertRelation.run(timeline, 2, 'B', 'C', 'BC', 1, blob(vector(0, 0, 1)));
    db.prepare('INSERT INTO entity_chunks VALUES (?, ?, ?)').run(timeline, 'A', 'entity');
    db.prepare('INSERT INTO entity_chunks VALUES (?, ?, ?)').run(timeline, 'B', 'relation');
    db.prepare('INSERT INTO entity_chunks VALUES (?, ?, ?)').run(timeline, 'C', 'entity');
    db.prepare('INSERT INTO relation_chunks VALUES (?, ?, ?)').run(timeline, 1, 'relation');
    db.prepare('INSERT INTO relation_chunks VALUES (?, ?, ?)').run(timeline, 2, 'relation');
  }
  chunks = new NarrativeChunksRepo(db);
  search = new NarrativeSearch(chunks, new NarrativeGraphRepo(db));
});


afterEach(() => db.close());

function run(query = '剧情问题', mode: Parameters<NarrativeSearch['search']>[1] = 'hybrid', signal = new AbortController().signal) {
  return search.search(query, mode, completeLLM, callEmbed, callRerank, signal);
}

it('周目和提词各调用一次 LLM, 所有周目共用原 Query 与关键词且只编码一次', async () => {
  await run();
  expect(completeLLM).toHaveBeenCalledTimes(2);
  expect(callEmbed).toHaveBeenCalledTimes(1);
  expect(callEmbed.mock.calls[0]![0].texts).toEqual(['剧情问题', '人物', '关系']);
  expect(callRerank).toHaveBeenCalledTimes(3);
  await run();
  expect(completeLLM).toHaveBeenCalledTimes(4);
  expect(callEmbed).toHaveBeenCalledTimes(2);
});

it('两条准备请求同时启动, 等两边完成后才编码', async () => {
  let finishRoute!: (value: LLMCompletion) => void;
  let finishKeywords!: (value: LLMCompletion) => void;
  completeLLM.mockImplementationOnce(() => new Promise(resolve => { finishRoute = resolve; }));
  completeLLM.mockImplementationOnce(() => new Promise(resolve => { finishKeywords = resolve; }));
  const result = run();
  expect(completeLLM).toHaveBeenCalledTimes(2);
  expect(callEmbed).not.toHaveBeenCalled();
  finishKeywords(reply(keywordResponse));
  await Promise.resolve();
  expect(callEmbed).not.toHaveBeenCalled();
  finishRoute(reply(routerResponse));
  await result;
  expect(callEmbed).toHaveBeenCalledTimes(1);
});

it('周目请求读摘要, 提词请求仅发送原版提词 Prompt 与相同 Query', async () => {
  const query = '第二周目安安案, 她落地后最终被谁杀死? 不要展开处刑.';
  const signal = new AbortController().signal;
  await run(query, 'mix', signal);
  expect(completeLLM.mock.calls[0]![0]).toEqual({
    messages: [
      { role: 'system', content: ROUTER_PROMPT },
      { role: 'user', content: query },
    ],
    temperature: 0.2,
    signal,
  });
  const extraction = completeLLM.mock.calls[1]![0];
  expect(extraction).toEqual({
    messages: [{ role: 'user', content: buildKeywordExtractionPrompt(query) }],
    temperature: 0.2,
    signal,
  });
  expect(String(extraction.messages[0]!.content)).not.toContain('城崎诺亚');
  expect(String(extraction.messages[0]!.content)).not.toContain('剧情摘要');
  expect(callEmbed.mock.calls[0]![0].texts).toEqual([query, '人物', '关系']);
  for (const [request] of callRerank.mock.calls) {
    expect(request.query).toBe(query);
  }
});

it('只清理 Query 首尾空白, 编码和重排保留问法与排除条件', async () => {
  const query = '第三周目真结局里, 城崎诺亚最后去了哪里? 不用展开之前的案件.';
  await run(`  ${query}\n`, 'naive');
  expect(completeLLM.mock.calls[0]![0].messages[1]?.content).toBe(query);
  expect(completeLLM.mock.calls[1]![0].messages[0]?.content).toBe(buildKeywordExtractionPrompt(query));
  expect(callEmbed.mock.calls[0]![0].texts).toEqual([query]);
  for (const [request] of callRerank.mock.calls) {
    expect(request.query).toBe(query);
  }
});

it.each([
  ['local', ['entity', 'relation']],
  ['global', ['entity', 'relation']],
  ['hybrid', ['entity', 'relation']],
  ['naive', ['direct 原文\n结束']],
  ['mix', ['direct 原文\n结束', 'entity', 'relation']],
] as const)('%s 召回来源原文, 返回正文而非图描述', async (mode, contents) => {
  const list = vi.spyOn(chunks, 'listVectors');
  const candidates = vi.spyOn(chunks, 'findVectorsByIds');
  const result = await run('剧情问题', mode);
  for (const timeline of timelines) {
    const rows = contextRows(textOf(result, timeline));
    expect(rows.map(row => row.content)).toEqual(contents.map(text => `${timeline}:${text}`));
    expect(textOf(result, timeline)).not.toContain('A 的背景');
  }
  expect(list).toHaveBeenCalledTimes(mode === 'naive' || mode === 'mix' ? 3 : 0);
  expect(candidates).toHaveBeenCalledTimes(mode === 'naive' || mode === 'mix' ? 0 : 3);
});

it('重排使用完整原问题和未截断原文, 返回结果按重排顺序而非向量顺序', async () => {
  routerResponse = routesFor(['3rd_Loop']);
  callRerank.mockResolvedValueOnce({ results: [{ index: 1, score: 0.9 }, { index: 0, score: 0.5 }] });
  const result = await run('艾玛，你跟希罗最后怎么样了？');
  expect(callRerank.mock.calls[0]![0]).toMatchObject({
    query: '艾玛，你跟希罗最后怎么样了？',
    documents: ['3rd_Loop:entity', '3rd_Loop:relation'],
    topK: 2,
  });
  expect(contextRows(textOf(result, '3rd_Loop')).map(row => row.content))
    .toEqual(['3rd_Loop:relation', '3rd_Loop:entity']);
});

it('一个周目重排失败不丢掉其他周目, 保留路由顺序', async () => {
  routerResponse = routesFor(['2nd_Loop', '1st_Loop']);
  callRerank.mockRejectedValueOnce(new Error('重排请求失败'));
  const result = await run();
  expect([...result.keys()]).toEqual(['2nd_Loop', '1st_Loop']);
  expect(result.get('2nd_Loop')).toEqual({ message: '重排请求失败' });
  expect(textOf(result, '1st_Loop')).toContain('1st_Loop:entity');
});

it('各周目独立重排并均分总预算, 不比较跨周目分数', async () => {
  db.prepare('UPDATE chunks SET content = content || ?').run('字'.repeat(5000));
  const result = await run();
  expect([...result.values()].reduce((sum, value) => sum + ('text' in value ? value.text.length : 0), 0))
    .toBeLessThanOrEqual(MAX_CONTEXT_CHARACTERS);
  for (const timeline of timelines) {
    expect(textOf(result, timeline)).toContain(timeline);
  }
  for (const [request] of callRerank.mock.calls) {
    const names = new Set(request.documents.map(text => text.split(':')[0]));
    expect(names.size).toBe(1);
  }
});

it('超过预算时保留完整前缀块, 不截断正文', () => {
  const rows = [{ chunk_id: 'a', content: '短文' }, { chunk_id: 'b', content: '字'.repeat(500) }];
  const result = buildContext(rows, 100);
  expect(JSON.parse(result)).toEqual(rows[0]);
});

it.each([
  ['local', { high_level_keywords: ['关系'], low_level_keywords: [] }],
  ['global', { high_level_keywords: [], low_level_keywords: ['人物'] }],
] as const)('%s 缺少本侧关键词仍可使用另一侧召回', async (mode, keywords) => {
  routerResponse = routesFor(['1st_Loop']);
  keywordResponse = JSON.stringify(keywords);
  expect(textOf(await run('剧情问题', mode), '1st_Loop')).toContain('1st_Loop:');
});

it('图模式两类关键词都为空时不调用编码或重排, naive 仍按原 Query 查原文', async () => {
  routerResponse = routesFor(['1st_Loop']);
  keywordResponse = JSON.stringify({ high_level_keywords: [], low_level_keywords: [] });
  expect((await run()).get('1st_Loop')).toEqual({ text: '' });
  expect(callEmbed).not.toHaveBeenCalled();
  expect(callRerank).not.toHaveBeenCalled();
  expect(textOf(await run('剧情问题', 'naive'), '1st_Loop')).toContain('direct');
});

it('编码返回错误维度时各周目失败且不重排', async () => {
  callEmbed.mockResolvedValueOnce({ dim: 3, embeddings: [] });
  const result = await run();
  expect([...result.values()]).toEqual(timelines.map(() => ({
    message: 'Narrative 需要 1024 维向量, 当前返回 3 维',
  })));
  expect(callRerank).not.toHaveBeenCalled();
});

it.each([
  '{}', '{"timelines":[]}', '{"timelines":["4th_Loop"]}',
  '{"timelines":["2nd_Loop","2nd_Loop"]}',
  '{"timelines":["3rd_Loop"],"query":"改写的问题"}',
  '{"3rd_Loop":{"query":"旧的子问题","high_level_keywords":[],"low_level_keywords":[]}}',
  'not-json',
])('无效周目结果整次失败, 不接受子 Query 或旧格式: %s', async response => {
  routerResponse = response;
  await expect(run()).rejects.toThrow();
  expect(callEmbed).not.toHaveBeenCalled();
  expect(callRerank).not.toHaveBeenCalled();
});

it.each([
  '{}', '{"high_level_keywords":[],"low_level_keywords":"人物"}',
  '{"high_level_keywords":[],"low_level_keywords":[""]}',
  '{"high_level_keywords":[],"low_level_keywords":[],"query":"改写"}',
  'not-json',
])('无效提词结果整次失败, 不编码或重排: %s', async response => {
  keywordResponse = response;
  await expect(run()).rejects.toThrow();
  expect(callEmbed).not.toHaveBeenCalled();
  expect(callRerank).not.toHaveBeenCalled();
});

it.each(['route', 'keywords'])('%s 请求失败不重试或退回混合路由', async failed => {
  const error = new Error('准备请求失败');
  if (failed === 'route') {
    completeLLM.mockRejectedValueOnce(error);
  } else {
    completeLLM.mockResolvedValueOnce(reply(routerResponse)).mockRejectedValueOnce(error);
  }
  await expect(run()).rejects.toBe(error);
  expect(completeLLM).toHaveBeenCalledTimes(2);
  expect(callEmbed).not.toHaveBeenCalled();
  expect(callRerank).not.toHaveBeenCalled();
});

it('空 Query 或已取消时不发出任何准备请求', async () => {
  await expect(run(' \n ')).rejects.toThrow('Narrative query must not be empty');
  const controller = new AbortController();
  const reason = new Error('用户停止');
  controller.abort(reason);
  await expect(run('剧情问题', 'hybrid', controller.signal)).rejects.toBe(reason);
  expect(completeLLM).not.toHaveBeenCalled();
});

it('准备阶段的两条请求都接收取消, 不继续编码', async () => {
  const controller = new AbortController();
  const reason = new Error('用户停止');
  const waitForAbort: CompleteLLM = request => new Promise((_resolve, reject) => {
    request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
  });
  completeLLM.mockImplementationOnce(waitForAbort).mockImplementationOnce(waitForAbort);
  const result = run('剧情问题', 'hybrid', controller.signal);
  expect(completeLLM).toHaveBeenCalledTimes(2);
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  expect(callEmbed).not.toHaveBeenCalled();
  expect(callRerank).not.toHaveBeenCalled();
});

it('周目等待调度时取消, 抛出取消原因', async () => {
  const controller = new AbortController();
  const reason = new Error('用户停止');
  callEmbed.mockImplementationOnce(async request => {
    setImmediate(() => controller.abort(reason));
    return { dim: 1024, embeddings: request.texts.map(() => vector(1)) };
  });
  await expect(run('剧情问题', 'mix', controller.signal)).rejects.toBe(reason);
  expect(callRerank).not.toHaveBeenCalled();
});

it('重排阶段取消不伪装成周目失败', async () => {
  routerResponse = routesFor(['3rd_Loop']);
  const controller = new AbortController();
  const reason = new Error('用户停止');
  callRerank.mockImplementationOnce(async () => {
    controller.abort(reason);
    throw reason;
  });
  await expect(run('剧情问题', 'hybrid', controller.signal)).rejects.toBe(reason);
});
