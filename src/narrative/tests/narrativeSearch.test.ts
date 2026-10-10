import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import type { CallEmbed } from '@ema-agent/embed';
import type { CallLlm } from '@ema-agent/llm';
import {
  NarrativeChunksRepo,
  NarrativeGraphRepo,
  NarrativeKeywordCacheRepo,
  type NarrativeTimelineId,
} from '@ema-agent/storage';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NarrativeSearch, type NarrativeRecallResult } from '../index.js';

const timelines: NarrativeTimelineId[] = ['1st_Loop', '2nd_Loop', '3rd_Loop'];
const routes = JSON.stringify(Object.fromEntries(timelines.map(id => [id, '剧情问题'])));
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
const callLlm = vi.fn<CallLlm>(async function* (request) {
  const router = request.messages[0]!.role === 'system';
  const content = request.messages.at(-1)!.content;
  if (!router && typeof content === 'string' && content.includes('提词失败')) {
    throw new Error('提词请求失败');
  }
  yield { type: 'thinking_delta', blockIndex: 0, delta: '这不是 JSON 结果' };
  yield { type: 'text_delta', blockIndex: 1, delta: router ? routerResponse : keywordResponse };
  yield { type: 'done', stopReason: 'end_turn' };
});
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
  routerResponse = routes;
  keywordResponse = '{"high_level_keywords":["关系"],"low_level_keywords":["人物"]}';
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  for (const name of ['narrative.sql', 'narrative-cache.sql']) {
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
  search = new NarrativeSearch(chunks, new NarrativeGraphRepo(db), new NarrativeKeywordCacheRepo(db));
});

afterEach(() => db.close());

it.each([
  ['local', ['A'], ['A'], ['entity', 'relation']],
  ['global', ['B', 'C'], ['B'], ['entity', 'relation']],
  ['hybrid', ['A', 'B', 'C'], ['A', 'B'], ['entity', 'relation']],
  ['naive', [], [], ['direct 原文\n结束']],
  ['mix', ['A', 'B', 'C'], ['A', 'B'], ['direct 原文\n结束', 'entity', 'relation']],
] as const)('%s 返回对应的图和正文, 来源选块不受直接召回阈值限制', async (mode, entities, relations, contents) => {
  const list = vi.spyOn(chunks, 'listVectors');
  const candidates = vi.spyOn(chunks, 'findVectorsByIds');
  const result = await search.search('剧情问题', mode, callLlm, callEmbed, new AbortController().signal);
  for (const timeline of timelines) {
    const rows = contextRows(textOf(result, timeline));
    expect(rows.flatMap(row => row.entity ? [row.entity] : [])).toEqual(entities);
    expect(rows.flatMap(row => row.entity1 ? [row.entity1] : [])).toEqual(relations);
    expect(rows.flatMap(row => row.content ? [row.content] : [])).toEqual(contents.map(text => `${timeline}:${text}`));
  }
  expect(callLlm).toHaveBeenCalledTimes(mode === 'naive' ? 1 : 2);
  expect(callEmbed).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledTimes(mode === 'naive' || mode === 'mix' ? 3 : 0);
  expect(candidates).toHaveBeenCalledTimes(mode === 'naive' || mode === 'mix' ? 0 : 3);
});

it('三周目共用一次提词与批量编码, 下次查询命中关键词缓存但重新读取候选向量', async () => {
  const candidates = vi.spyOn(chunks, 'findVectorsByIds');
  const run = () => search.search('剧情问题', 'hybrid', callLlm, callEmbed, new AbortController().signal);
  await run();
  expect(callEmbed.mock.calls[0]![0].texts).toEqual(['剧情问题', '人物', '关系']);
  const key = 'hybrid:keywords:' + createHash('md5').update('hybrid剧情问题English').digest('hex');
  expect(db.prepare('SELECT * FROM keyword_cache').all()).toEqual([{
    cache_key: key, high_level_keywords: '["关系"]', low_level_keywords: '["人物"]',
  }]);
  await run();
  expect(callLlm).toHaveBeenCalledTimes(3);
  expect(callEmbed).toHaveBeenCalledTimes(2);
  expect(candidates).toHaveBeenCalledTimes(6);
});

it.each([
  ['local', '{"high_level_keywords":["关系"],"low_level_keywords":[]}', ['B', 'C']],
  ['global', '{"high_level_keywords":[],"low_level_keywords":["人物"]}', ['A']],
] as const)('%s 缺少本侧关键词时使用另一侧召回', async (mode, keywords, entities) => {
  keywordResponse = keywords;
  const result = await search.search('剧情问题', mode, callLlm, callEmbed, new AbortController().signal);
  expect(contextRows(textOf(result, '1st_Loop')).flatMap(row => row.entity ? [row.entity] : [])).toEqual(entities);
});

it('一条子问题提词失败不丢掉另一周目的成功结果, Map 保留路由顺序', async () => {
  routerResponse = '{"2nd_Loop":"提词失败","1st_Loop":"剧情问题"}';
  const result = await search.search('剧情问题', 'hybrid', callLlm, callEmbed, new AbortController().signal);
  expect([...result.keys()]).toEqual(['2nd_Loop', '1st_Loop']);
  expect(result.get('2nd_Loop')).toEqual({ code: 'timeline_query_failed', message: '提词请求失败' });
  expect(textOf(result, '1st_Loop')).toContain('1st_Loop:entity');
});

it('无效提词 JSON 对短问题使用原问题, 未命中返回空文本且不缓存临时关键词', async () => {
  keywordResponse = 'not-json';
  const result = await search.search('剧情问题', 'local', callLlm, callEmbed, new AbortController().signal);
  expect(result.get('1st_Loop')).toEqual({ text: '' });
  expect(db.prepare('SELECT * FROM keyword_cache').all()).toEqual([]);
});

it('第一块超过字符限制时停止取正文, 不跳过它去拼后面的块', async () => {
  db.prepare('UPDATE chunks SET content = ? WHERE chunk_id = ?').run('long '.repeat(40000), 'entity');
  const result = await search.search('剧情问题', 'local', callLlm, callEmbed, new AbortController().signal);
  const rows = contextRows(textOf(result, '1st_Loop'));
  expect(rows.some(row => row.entity === 'A')).toBe(true);
  expect(rows.filter(row => row.content !== undefined)).toEqual([]);
});

it('实体背景超过 18000 字符时不进入来源选块, 相邻关系仍能返回', async () => {
  db.prepare('UPDATE entities SET description = ? WHERE entity_name = ?').run('字'.repeat(18001), 'A');
  const result = await search.search('剧情问题', 'local', callLlm, callEmbed, new AbortController().signal);
  const rows = contextRows(textOf(result, '1st_Loop'));
  expect(rows.some(row => row.entity === 'A')).toBe(false);
  expect(rows.some(row => row.entity1 === 'A')).toBe(true);
});

it('编码返回错误维度时记录各周目失败, 不进入向量检索', async () => {
  callEmbed.mockResolvedValueOnce({ dim: 3, embeddings: [] });
  const result = await search.search('剧情问题', 'hybrid', callLlm, callEmbed, new AbortController().signal);
  expect([...result.values()]).toEqual(timelines.map(() => ({
    code: 'timeline_query_failed', message: 'Narrative 需要 1024 维向量, 当前返回 3 维',
  })));
});

it('路由到不存在的周目时抛错, 不编码或读取剧情向量', async () => {
  routerResponse = '{"4th_Loop":"剧情问题"}';
  await expect(search.search('剧情问题', 'mix', callLlm, callEmbed, new AbortController().signal)).rejects.toThrow();
  expect(callEmbed).not.toHaveBeenCalled();
});

it('周目任务等待调度时取消, 抛出原始取消原因而不是周目失败', async () => {
  const controller = new AbortController();
  const reason = new Error('用户停止');
  callEmbed.mockImplementationOnce(async request => {
    // 下一次事件循环先取消, 编码正常返回, 三个周目仍在等待开始检索.
    setImmediate(() => controller.abort(reason));
    return { dim: 1024, embeddings: request.texts.map(() => vector(1)) };
  });
  await expect(search.search('剧情问题', 'mix', callLlm, callEmbed, controller.signal)).rejects.toBe(reason);
});
