import { readFileSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import type { CallEmbed } from '@ema-agent/embed';
import type { CompleteLLM, LLMCompletion } from '@ema-agent/llm';
import type { CallRerank } from '@ema-agent/rerank';
import { selectChunksWithinBudget } from '../pipeline/chunkBudget.js';
import {
  MAX_CHUNK_CHARACTERS,
  RERANK_CANDIDATE_LIMIT,
  RERANK_TOP_K,
  VECTOR_CHUNK_TOP_K,
} from '../pipeline/constants.js';
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
  const value = result.chunksByTimeline.get(timeline);
  if (value === undefined || 'message' in value) {
    throw new Error(`没有成功检索 ${timeline}`);
  }
  return JSON.stringify(value);
}

function contextRows(text: string): Array<{ entity?: string; entity1?: string; content?: string }> {
  return JSON.parse(text);
}

beforeEach(() => {
  vi.clearAllMocks();
  routerResponse = routesFor();
  keywordResponse = JSON.stringify({ high_level_keywords: ['关系'], low_level_keywords: ['人物'] });
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(
    new URL('../../storage/migrations/narrative/003_narrativeSchema.sql', import.meta.url),
    'utf8',
  ));
  const insertChunk = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
  const insertEntity = db.prepare('INSERT INTO entities VALUES (?, ?, ?, ?)');
  const insertRelation = db.prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)');
  const insertEntitySource = db.prepare('INSERT INTO entity_chunks VALUES (?, ?)');
  const insertRelationSource = db.prepare('INSERT INTO relation_chunks VALUES (?, ?)');
  for (const [index, timeline] of timelines.entries()) {
    const entity = `${timeline}:entity`;
    const relation = `${timeline}:relation`;
    const entityA = `A-${timeline}`;
    const entityB = `B-${timeline}`;
    const entityC = `C-${timeline}`;
    const relationAB = index * 2 + 1;
    const relationBC = relationAB + 1;
    insertChunk.run(`${timeline}:direct`, timeline, `${timeline}:direct 原文\n结束`, blob(vector(1)));
    insertChunk.run(entity, timeline, entity, blob(vector(0.1, Math.sqrt(0.99))));
    insertChunk.run(relation, timeline, relation, blob(vector(0.05, 0, Math.sqrt(0.9975))));
    insertEntity.run(entityA, 'person', 'A 的背景', blob(vector(0, 1)));
    insertEntity.run(entityB, 'person', 'B 的背景', blob(vector(0, -1)));
    insertEntity.run(entityC, 'person', 'C 的背景', blob(vector(0, -1)));
    insertRelation.run(relationAB, entityA, entityB, 'AB', 1, blob(vector(0, 0, -1)));
    insertRelation.run(relationBC, entityB, entityC, 'BC', 1, blob(vector(0, 0, 1)));
    insertEntitySource.run(entityA, entity);
    insertEntitySource.run(entityB, relation);
    insertEntitySource.run(entityC, entity);
    insertRelationSource.run(relationAB, relation);
    insertRelationSource.run(relationBC, relation);
  }
  chunks = new NarrativeChunksRepo(db);
  search = new NarrativeSearch(chunks, new NarrativeGraphRepo(db));
});


afterEach(() => db.close());

function run(query = '剧情问题', mode: Parameters<NarrativeSearch['search']>[1] = 'hybrid', signal = new AbortController().signal) {
  return search.search(query, mode, completeLLM, callEmbed, callRerank, signal);
}

it('hybrid 只提词一次, 全库共用原 Query 与关键词向量', async () => {
  routerResponse = 'not-json';
  await run();
  expect(completeLLM).toHaveBeenCalledTimes(1);
  expect(callEmbed).toHaveBeenCalledTimes(1);
  expect(callEmbed.mock.calls[0]![0].texts).toEqual(['剧情问题', '人物', '关系']);
  expect(callRerank).toHaveBeenCalledTimes(3);
  await run();
  expect(completeLLM).toHaveBeenCalledTimes(2);
  expect(callEmbed).toHaveBeenCalledTimes(2);
});

it('naive 在周目判断返回前发出编码请求, 两个结果齐全后才读取 SQLite', async () => {
  let finishRouting!: (value: LLMCompletion) => void;
  completeLLM.mockImplementationOnce(() => new Promise(resolve => { finishRouting = resolve; }));
  const listVectors = vi.spyOn(chunks, 'listVectors');
  const result = run('剧情问题', 'naive');
  expect(completeLLM).toHaveBeenCalledTimes(1);
  expect(callEmbed).toHaveBeenCalledTimes(1);
  expect(listVectors).not.toHaveBeenCalled();
  finishRouting(reply(routerResponse));
  await result;
  expect(listVectors).toHaveBeenCalledTimes(1);
});

it('hybrid 等待提词后才编码', async () => {
  let finishPreparation!: (value: LLMCompletion) => void;
  completeLLM.mockImplementationOnce(() => new Promise(resolve => { finishPreparation = resolve; }));
  const result = run('剧情问题', 'hybrid');
  expect(completeLLM).toHaveBeenCalledTimes(1);
  expect(callEmbed).not.toHaveBeenCalled();
  finishPreparation(reply(keywordResponse));
  await result;
  expect(callEmbed).toHaveBeenCalledTimes(1);
});

it('mix 只发送原版提词 Prompt 与原 Query', async () => {
  const query = '第二周目安安案, 她落地后最终被谁杀死? 不要展开处刑.';
  const signal = new AbortController().signal;
  await run(query, 'mix', signal);
  expect(completeLLM).toHaveBeenCalledTimes(1);
  const extraction = completeLLM.mock.calls[0]![0];
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
  expect(completeLLM).toHaveBeenCalledTimes(1);
  expect(completeLLM.mock.calls[0]![0].messages).toEqual([
    { role: 'system', content: ROUTER_PROMPT },
    { role: 'user', content: query },
  ]);
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
] as const)('%s 返回来源原文, 图模式同时保留命中的实体和关系', async (mode, contents) => {
  const list = vi.spyOn(chunks, 'listVectors');
  const candidates = vi.spyOn(chunks, 'findVectorsByIds');
  const result = await run('剧情问题', mode);
  for (const timeline of timelines) {
    const rows = contextRows(textOf(result, timeline));
    expect(rows.map(row => row.content)).toEqual(contents.map(text => `${timeline}:${text}`));
    expect(textOf(result, timeline)).not.toContain('A 的背景');
  }
  if (mode === 'naive') {
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
    expect(list).toHaveBeenCalledWith(timelines);
  } else {
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.relations.length).toBeGreaterThan(0);
    if (mode === 'mix') {
      expect(list).toHaveBeenCalledWith();
    }
  }
  expect(list).toHaveBeenCalledTimes(mode === 'naive' || mode === 'mix' ? 1 : 0);
  expect(candidates).toHaveBeenCalledTimes(mode === 'naive' || mode === 'mix' ? 0 : 1);
});

it('重排使用完整原问题和未截断原文, 返回结果按重排顺序而非向量顺序', async () => {
  callRerank.mockResolvedValueOnce({ results: [{ index: 1, score: 0.9 }, { index: 0, score: 0.5 }] });
  const result = await run('艾玛，你跟希罗最后怎么样了？');
  expect(callRerank.mock.calls[0]![0]).toMatchObject({
    query: '艾玛，你跟希罗最后怎么样了？',
    documents: ['1st_Loop:entity', '1st_Loop:relation'],
    topK: 2,
  });
  expect(contextRows(textOf(result, '1st_Loop')).map(row => row.content))
    .toEqual(['1st_Loop:relation', '1st_Loop:entity']);
});

it('直接原文粗筛取 100 块, 重排最多返回 30 块', async () => {
  routerResponse = routesFor(['1st_Loop']);
  const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
  for (let index = 0; index < 110; index++) {
    insert.run(`candidate-${index}`, '1st_Loop', `原文候选 ${index}`, blob(vector(1)));
  }
  const result = await run('剧情问题', 'naive');
  const request = callRerank.mock.calls[0]![0];
  expect(VECTOR_CHUNK_TOP_K).toBe(100);
  expect(request.documents).toHaveLength(100);
  expect(request.topK).toBe(30);
  expect(contextRows(textOf(result, '1st_Loop'))).toHaveLength(30);
});

it('mix 合并图来源后可以送入超过 100 块, 返回数仍限制为 30', async () => {
  db.prepare("UPDATE chunks SET vector = ? WHERE timeline_id <> '1st_Loop' AND chunk_id LIKE '%:direct'")
    .run(blob(vector(0, 1)));
  const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
  for (let index = 0; index < 110; index++) {
    insert.run(`candidate-${index}`, '1st_Loop', `原文候选 ${index}`, blob(vector(1)));
  }
  const result = await run('剧情问题', 'mix');
  const request = callRerank.mock.calls[0]![0];
  expect(request.documents).toHaveLength(102);
  expect(request.documents).toContain('1st_Loop:entity');
  expect(request.documents).toContain('1st_Loop:relation');
  expect(request.topK).toBe(30);
  expect(contextRows(textOf(result, '1st_Loop'))).toHaveLength(30);
});

it('候选先按周目截取前 125 个 ID, 正文一次批量读取并按重排下标返回', async () => {
  const timeline = '1st_Loop';
  const insertChunk = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
  const insertEntity = db.prepare('INSERT INTO entities VALUES (?, ?, ?, ?)');
  const insertSource = db.prepare('INSERT INTO entity_chunks VALUES (?, ?)');
  for (let index = 0; index < 130; index++) {
    insertChunk.run(`direct-${index}`, timeline, `${timeline}:direct-${index}`, blob(vector(1)));
  }
  for (let index = 0; index < 45; index++) {
    const name = `人物-${index}`;
    insertEntity.run(name, 'person', name, blob(vector(0, 1)));
    for (let source = 0; source < 3; source++) {
      const id = `graph-${index}-${source}`;
      insertChunk.run(id, timeline, `${timeline}:${id}`, blob(vector(0, 1)));
      insertSource.run(name, id);
    }
  }
  callRerank.mockImplementationOnce(async () => ({
    results: [124, ...Array.from({ length: 29 }, (_, index) => index)]
      .map((index, rank) => ({ index, score: 1 - rank / 100 })),
  }));

  const read = vi.spyOn(chunks, 'findChunksByIds');
  const result = await run('剧情问题', 'mix');
  expect(read).toHaveBeenCalledTimes(1);
  const rowsById = read.mock.results[0]!.value;
  const firstTimelineChunks = read.mock.calls[0]![0]
    .map(id => rowsById.get(id)!)
    .filter(chunk => chunk.timeline_id === timeline);
  const request = callRerank.mock.calls[0]![0];
  expect(firstTimelineChunks).toHaveLength(125);
  expect(request.documents).toEqual(firstTimelineChunks.map(chunk => chunk.content));
  expect(request.topK).toBe(30);
  expect(contextRows(textOf(result, timeline)).map(row => row.content)).toEqual([
    request.documents[124],
    ...request.documents.slice(0, 29),
  ]);
  expect(RERANK_CANDIDATE_LIMIT).toBe(125);
  expect(RERANK_TOP_K).toBe(30);
});

it.each(['local', 'global', 'hybrid', 'mix'] as const)('%s 不按图描述长度排除关联来源块', async mode => {
  const description = '图描述'.repeat(20_000);
  db.prepare('UPDATE entities SET description = ?').run(description);
  db.prepare('UPDATE relations SET description = ?').run(description);
  const result = await run('剧情问题', mode);
  const request = callRerank.mock.calls[0]![0];
  expect(request.documents).toContain('1st_Loop:entity');
  expect(request.documents).toContain('1st_Loop:relation');
  expect(textOf(result, '1st_Loop')).not.toContain(description);
  expect(result.entities[0]?.description).toBe(description);
  expect(result.relations[0]?.description).toBe(description);
});

it('不足 30 个候选时请求全部结果, 仍按 32000 字符预算保留完整前缀块', async () => {
  routerResponse = routesFor(['1st_Loop']);
  const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
  for (let index = 0; index < 25; index++) {
    insert.run(`large-${index}`, '1st_Loop', `原文 ${index}:` + '字'.repeat(2_000), blob(vector(1)));
  }
  const result = await run('剧情问题', 'naive');
  const request = callRerank.mock.calls[0]![0];
  expect(request.documents).toHaveLength(26);
  expect(request.topK).toBe(26);
  const text = textOf(result, '1st_Loop');
  const rows = contextRows(text);
  expect(rows.length).toBeGreaterThan(8);
  expect(rows.length).toBeLessThan(request.documents.length);
  expect(text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARACTERS);
  expect(rows.map(row => row.content)).toEqual(request.documents.slice(0, rows.length));
});

it('一个周目重排失败不丢掉其他周目, 保留路由顺序', async () => {
  routerResponse = routesFor(['2nd_Loop', '1st_Loop']);
  callRerank.mockRejectedValueOnce(new Error('重排请求失败'));
  const result = await run('剧情问题', 'naive');
  expect([...result.chunksByTimeline.keys()]).toEqual(['2nd_Loop', '1st_Loop']);
  expect(result.chunksByTimeline.get('2nd_Loop')).toEqual({ message: '重排请求失败' });
  expect(textOf(result, '1st_Loop')).toContain('1st_Loop:direct');
});

it('各周目独立重排并均分总预算, 不比较跨周目分数', async () => {
  db.prepare('UPDATE chunks SET content = content || ?').run('字'.repeat(5000));
  const result = await run();
  const size = [...result.chunksByTimeline.values()].reduce((sum, value) =>
    sum + ('message' in value ? 0 : JSON.stringify(value).length), 0);
  expect(size).toBeLessThanOrEqual(MAX_CHUNK_CHARACTERS);
  for (const timeline of timelines) {
    expect(textOf(result, timeline)).toContain(timeline);
  }
  for (const [request] of callRerank.mock.calls) {
    const names = new Set(request.documents.map(text => text.split(':')[0]));
    expect(names.size).toBe(1);
  }
});

it('超过预算时保留完整前缀块, 不截断正文', () => {
  const rows = [{ chunk_id: 'a', timeline_id: '1st_Loop' as const, content: '短文' }, { chunk_id: 'b', timeline_id: '1st_Loop' as const, content: '字'.repeat(500) }];
  const result = selectChunksWithinBudget(rows, 100);
  expect(result).toEqual([rows[0]]);
});

it('正文预算按 UTF-16 计入 JSON 转义和数组分隔符', () => {
  const rows = [
    { chunk_id: 'a', timeline_id: '1st_Loop' as const, content: '中文😀\n\"\\' },
    { chunk_id: 'b', timeline_id: '1st_Loop' as const, content: '第二块' },
  ];
  const joined = JSON.stringify(rows);
  expect(selectChunksWithinBudget(rows, joined.length)).toEqual(rows);
  expect(selectChunksWithinBudget(rows, joined.length - 1)).toEqual([rows[0]]);
});

it('第一块超过正文预算时返回空正文, 不跳过它另选后面的短块', () => {
  const rows = [
    { chunk_id: 'a', timeline_id: '1st_Loop' as const, content: '字'.repeat(200) },
    { chunk_id: 'b', timeline_id: '1st_Loop' as const, content: '短块' },
  ];
  expect(selectChunksWithinBudget(rows, 100)).toEqual([]);
});

it.each([
  ['local', { high_level_keywords: ['关系'], low_level_keywords: [] }],
  ['global', { high_level_keywords: [], low_level_keywords: ['人物'] }],
] as const)('%s 缺少本侧关键词仍可使用另一侧召回', async (mode, keywords) => {
  keywordResponse = JSON.stringify(keywords);
  expect(textOf(await run('剧情问题', mode), '1st_Loop')).toContain('1st_Loop:');
});

it('图模式两类关键词都为空时不调用编码或重排, naive 仍按原 Query 查原文', async () => {
  routerResponse = routesFor(['1st_Loop']);
  keywordResponse = JSON.stringify({ high_level_keywords: [], low_level_keywords: [] });
  expect(await run()).toEqual({ entities: [], relations: [], chunksByTimeline: new Map() });
  expect(callEmbed).not.toHaveBeenCalled();
  expect(callRerank).not.toHaveBeenCalled();
  expect(textOf(await run('剧情问题', 'naive'), '1st_Loop')).toContain('direct');
});

it.each(['naive', 'hybrid'] as const)('%s 编码返回错误维度时整次失败, 不重排', async mode => {
  callEmbed.mockResolvedValueOnce({ dim: 3, embeddings: [] });
  await expect(run('剧情问题', mode)).rejects.toThrow('Narrative 需要 1024 维向量, 当前返回 3 维');
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
  await expect(run('剧情问题', 'naive')).rejects.toThrow();
  expect(callEmbed).toHaveBeenCalledTimes(1);
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

it.each(['naive', 'hybrid'] as const)('%s 准备请求失败时整次失败', async mode => {
  const error = new Error('准备请求失败');
  completeLLM.mockRejectedValueOnce(error);
  await expect(run('剧情问题', mode)).rejects.toBe(error);
  expect(completeLLM).toHaveBeenCalledTimes(1);
  expect(callEmbed).toHaveBeenCalledTimes(mode === 'naive' ? 1 : 0);
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

it.each(['naive', 'hybrid'] as const)('%s 准备请求接收取消, 不继续检索', async mode => {
  const controller = new AbortController();
  const reason = new Error('用户停止');
  const waitForAbort: CompleteLLM = request => new Promise((_resolve, reject) => {
    request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
  });
  completeLLM.mockImplementationOnce(waitForAbort);
  const result = run('剧情问题', mode, controller.signal);
  expect(completeLLM).toHaveBeenCalledTimes(1);
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  expect(callEmbed).toHaveBeenCalledTimes(mode === 'naive' ? 1 : 0);
  if (mode === 'naive') {
    expect(callEmbed.mock.calls[0]![0].signal).toBe(controller.signal);
  }
  expect(callRerank).not.toHaveBeenCalled();
});

it('读取 SQLite 前取消, 抛出取消原因', async () => {
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
  const controller = new AbortController();
  const reason = new Error('用户停止');
  callRerank.mockImplementationOnce(async () => {
    controller.abort(reason);
    throw reason;
  });
  await expect(run('剧情问题', 'hybrid', controller.signal)).rejects.toBe(reason);
});
