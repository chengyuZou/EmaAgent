import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/contracts';
import { LlmTurnMetricsRepo } from '../../src/repos/llm-turn-metrics.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('LLM Turn Metrics Repo', () => {
  let database: TestDatabase;
  let repo: LlmTurnMetricsRepo;

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES ('session-a', 'Session A', 1, 1)
    `).run();
    const insertTurn = database.db.prepare(`
      INSERT INTO turns (id, session_id, mode, status, user_input, started_at)
      VALUES (?, 'session-a', 'chat', 'completed', 'test', ?)
    `);
    insertTurn.run('turn-a', 1);
    insertTurn.run('turn-b', 2);
    repo = new LlmTurnMetricsRepo(database.db);
  });

  afterEach(() => database.close());

  it('按 Turn 原子 upsert 完整指标，而不是使用 DELETE + INSERT', () => {
    repo.upsert({
      turn_id: 'turn-a',
      llm_provider: 'openai-llm',
      model_id: 'model-old',
      input_tokens: 10,
      output_tokens: 20,
      cost_usd: 0.01,
      duration_ms: 100,
      created_at: 10,
    });
    repo.upsert({
      turn_id: 'turn-a',
      llm_provider: 'anthropic-llm',
      model_id: 'model-new',
      input_tokens: 30,
      output_tokens: 40,
      cost_usd: 0.02,
      duration_ms: 200,
      created_at: 20,
    });

    expect(repo.forTurn(asTurnId('turn-a'))).toMatchObject({
      llm_provider: 'anthropic-llm',
      model_id: 'model-new',
      input_tokens: 30,
      output_tokens: 40,
      duration_ms: 200,
    });
  });

  it('Session 查询在同毫秒指标下按 turn_id 稳定倒序', () => {
    for (const turnId of ['turn-a', 'turn-b']) {
      repo.upsert({
        turn_id: turnId,
        llm_provider: 'openai-llm',
        model_id: 'model-a',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        duration_ms: 1,
        created_at: 100,
      });
    }

    expect(repo.forSession(asSessionId('session-a')).map((row) => row.turn_id))
      .toEqual(['turn-b', 'turn-a']);
  });
});
