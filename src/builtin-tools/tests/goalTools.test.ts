// 验证根 Goal 工具的进度与终态写入, 关闭错误和禁止模型取消或激活.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Database, SessionsRepo } from '@ema-agent/storage';
import { GoalStore } from '@ema-agent/goal';
import type { ToolInvocation } from '@ema-agent/tools';
import { GoalGetTool } from '../tools/GoalGetTool/GoalGetTool.js';
import { GoalUpdateTool } from '../tools/GoalUpdateTool/GoalUpdateTool.js';

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const db = new Database({ memory: true, kind: 'data' });
  databases.push(db);
  db.migrate();
  new SessionsRepo(db.sqlite).insert({
    id: 'session', title: 'Session', cwd: '/workspace', createdAt: 1, updatedAt: 1,
  });
  const goalStore = new GoalStore(db);
  const goal = goalStore.create('session', '整理 8 个 README');
  const invocation: ToolInvocation = {
    sessionId: 'session', turnId: 'turn', toolCallId: 'call-goal',
    signal: new AbortController().signal,
  };
  return { goalStore, goal, invocation };
}

describe('Goal tools', () => {
  it('进度写入由 GoalGet 回读, 后续完成使用更新后的版本', async () => {
    const { goalStore, goal, invocation } = fixture();
    const reported = await GoalUpdateTool.execute(GoalUpdateTool.inputSchema.parse({
      goalId: goal.id, expectedVersion: goal.version, status: 'active', feedback: ' 已整理 2/8 ',
    }), { goalStore }, invocation);
    expect(reported).toMatchObject({ status: 'active', feedback: '已整理 2/8', version: 2 });
    expect(await GoalGetTool.execute({}, { goalStore }, invocation)).toEqual(reported);
    const completed = await GoalUpdateTool.execute(GoalUpdateTool.inputSchema.parse({
      goalId: goal.id, expectedVersion: reported.version, status: 'completed', reason: 'succeeded',
      feedback: '全部已整理',
    }), { goalStore }, invocation);
    expect(completed).toMatchObject({ status: 'completed', reason: 'succeeded', feedback: '全部已整理' });
    expect(await GoalGetTool.execute({}, { goalStore }, invocation)).toBeNull();
  });

  it('完成输入必须提供新的反馈, 不沿用旧进度', async () => {
    const { goalStore, goal, invocation } = fixture();
    expect(GoalUpdateTool.inputSchema.safeParse({
      goalId: goal.id, expectedVersion: goal.version, status: 'completed', reason: 'succeeded',
    }).success).toBe(false);
    const completed = await GoalUpdateTool.execute(GoalUpdateTool.inputSchema.parse({
      goalId: goal.id, expectedVersion: goal.version, status: 'completed', reason: 'succeeded',
      feedback: '8/8 已整理, 完整结果见本轮最终回复',
    }), { goalStore }, invocation);
    expect(completed.feedback).toBe('8/8 已整理, 完整结果见本轮最终回复');
  });

  it('最终失败保存 error, 临时进度不伪装成失败', async () => {
    const { goalStore, goal, invocation } = fixture();
    const failed = await GoalUpdateTool.execute(GoalUpdateTool.inputSchema.parse({
      goalId: goal.id, expectedVersion: goal.version, status: 'completed', reason: 'failed',
      feedback: '已检查输入, 无法继续',
      error: '目标所需数据已永久丢失',
    }), { goalStore }, invocation);
    expect(failed).toMatchObject({ status: 'completed', reason: 'failed', error: '目标所需数据已永久丢失' });
  });

  it('取消或删除后返回关闭指令, 旧工具不能重建 Goal', async () => {
    const { goalStore, goal, invocation } = fixture();
    const cancelled = goalStore.cancel({ sessionId: 'session', goalId: goal.id, expectedVersion: goal.version });
    const input = GoalUpdateTool.inputSchema.parse({
      goalId: goal.id, expectedVersion: goal.version, status: 'active', feedback: '继续执行旧目标',
    });
    await expect(GoalUpdateTool.execute(input, { goalStore }, invocation))
      .rejects.toThrow('This Goal is closed or deleted. Stop pursuing its objective.');
    goalStore.delete({ sessionId: 'session', goalId: goal.id, expectedVersion: cancelled.version });
    await expect(GoalUpdateTool.execute(input, { goalStore }, invocation))
      .rejects.toThrow('This Goal is closed or deleted. Stop pursuing its objective.');
    expect(goalStore.listSummaries('session')).toEqual([]);
  });

  it('paused 拒绝 active 反馈, 新版目标拒绝旧完成判断', async () => {
    const { goalStore, goal, invocation } = fixture();
    const edited = goalStore.edit({ sessionId: 'session', goalId: goal.id, expectedVersion: goal.version }, '只整理两个文件');
    await expect(GoalUpdateTool.execute(GoalUpdateTool.inputSchema.parse({
      goalId: goal.id, expectedVersion: goal.version, status: 'completed', reason: 'succeeded',
      feedback: '旧目标已完成',
    }), { goalStore }, invocation)).rejects.toThrow('Do not blindly retry an old judgment');
    const paused = goalStore.pause({ sessionId: 'session', goalId: goal.id, expectedVersion: edited.version });
    await expect(GoalUpdateTool.execute(GoalUpdateTool.inputSchema.parse({
      goalId: goal.id, expectedVersion: paused.version, status: 'active', feedback: '自行恢复',
    }), { goalStore }, invocation)).rejects.toThrow('This Goal is paused. Stop pursuing its objective');
    expect(goalStore.getCurrent('session')).toEqual(paused);
  });

  it('输入拒绝取消, 删除, 暂停, 空反馈和修改正文, 无 Store 时不暴露工具', () => {
    const { goal } = fixture();
    const identity = { goalId: goal.id, expectedVersion: goal.version };
    for (const invalid of [
      { ...identity, status: 'completed', reason: 'cancelled' },
      { ...identity, action: 'cancel' },
      { ...identity, action: 'delete' },
      { ...identity, status: 'paused' },
      { ...identity, status: 'active', feedback: ' ' },
      { ...identity, status: 'active', feedback: '进度', reason: 'succeeded' },
      { ...identity, status: 'completed' },
      { ...identity, status: 'completed', reason: 'succeeded', error: '不应出现' },
      { ...identity, status: 'completed', reason: 'failed' },
      { ...identity, status: 'active', feedback: '进度', objective: '模型改写要求' },
    ]) {
      expect(GoalUpdateTool.inputSchema.safeParse(invalid).success).toBe(false);
    }
    const context = { cwd: '', platform: process.platform };
    expect(GoalGetTool.validateContext(context).valid).toBe(false);
    expect(GoalUpdateTool.validateContext(context).valid).toBe(false);
    const schema = z.toJSONSchema(GoalUpdateTool.inputSchema);
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('oneOf');
    expect(JSON.stringify(schema)).toContain('feedback');
    expect(JSON.stringify(schema)).not.toContain('cancelled');
  });
});
