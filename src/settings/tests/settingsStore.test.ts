// 测试类型化设置的读写顺序:写必须先落库再发事件;读每次过 zod safeParse,
// 坏值回落默认;有跨字段约束的组在写入时整组 refine。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  InvalidSettingGroupValueError,
  InvalidSettingValueError,
  SettingsStore,
  defineSetting,
} from '../index.js';
import type { SettingGroup } from '../types.js';

const countSetting = defineSetting<number>({
  key: 'test.count',
  description: '测试计数设置。',
  apply: 'immediate',
  defaultValue: 3,
  schema: z.number().int().min(0),
});

// 组内跨字段约束示例:maxConcurrentSubagents ≤ maxSubagents
const maxSubagentsSetting = defineSetting<number>({
  key: 'agent.limits.maxSubagents',
  description: '测试：最大子代理数。',
  apply: 'nextTurn',
  defaultValue: 16,
  schema: z.number().int().min(1).max(32),
  group: 'agent.limits',
});
const maxConcurrentSubagentsSetting = defineSetting<number>({
  key: 'agent.limits.maxConcurrentSubagents',
  description: '测试：最大并发子代理数。',
  apply: 'nextTurn',
  defaultValue: 4,
  schema: z.number().int().min(1).max(8),
  group: 'agent.limits',
});

const agentLimitsGroup: SettingGroup = {
  id: 'agent.limits',
  description: '测试：Agent 执行限制组。',
  definitions: [maxSubagentsSetting, maxConcurrentSubagentsSetting],
  schema: z
    .object({
      'agent.limits.maxSubagents': z.number(),
      'agent.limits.maxConcurrentSubagents': z.number(),
    })
    .refine(
      g =>
        g['agent.limits.maxConcurrentSubagents'] <=
        g['agent.limits.maxSubagents'],
      { message: 'maxConcurrentSubagents 不能大于 maxSubagents' },
    ),
};

const memory: Record<string, unknown> = {};

function makeStore(options: { groups?: readonly SettingGroup[] } = {}) {
  return new SettingsStore(
    {
      read: key => (key in memory ? { status: 'found', value: memory[key] } : { status: 'missing' }),
      set: (key, value) => { memory[key] = value; },
      setMany: entries => { for (const e of entries) memory[e.key] = e.value; },
      delete: key => { delete memory[key]; },
    },
    options,
  );
}

beforeEach(() => {
  for (const key of Object.keys(memory)) delete memory[key];
});

describe('SettingsStore', () => {
  it('SQLite 写入失败时不发变更事件,随后读取仍拿到库里的旧值', () => {
    const listener = vi.fn();
    const store = new SettingsStore({
      read: () => ({ status: 'found', value: 4 }),
      set: () => { throw new Error('disk full'); },
      setMany: () => {},
      delete: () => {},
    });
    store.subscribe(listener);

    expect(store.get(countSetting)).toBe(4);
    expect(() => store.set(countSetting, 8)).toThrow('disk full');
    expect(store.get(countSetting)).toBe(4);
    expect(listener).not.toHaveBeenCalled();
  });

  it('持久化值损坏或类型不符时使用业务默认值', () => {
    const corrupted = new SettingsStore({
      read: () => ({ status: 'corrupted', rawValue: '{' }),
      set: () => {},
      setMany: () => {},
      delete: () => {},
    });
    const invalid = new SettingsStore({
      read: () => ({ status: 'found', value: -1 }),
      set: () => {},
      setMany: () => {},
      delete: () => {},
    });

    expect(corrupted.get(countSetting)).toBe(3);
    expect(invalid.get(countSetting)).toBe(3);
  });

  it('set 成功后发一次事件并携带变更键;读取返回校验后的规范化值', () => {
    const listener = vi.fn();
    const store = makeStore();
    store.subscribe(listener);

    expect(store.set(countSetting, 9)).toBe(9);
    expect(store.get(countSetting)).toBe(9);
    expect(listener).toHaveBeenCalledWith({ revision: 1, changedKeys: ['test.count'] });
  });

  it('set 时单 key 校验失败抛 InvalidSettingValueError 且不落库', () => {
    const store = makeStore();
    expect(() => store.set(countSetting, -5)).toThrow(InvalidSettingValueError);
    expect(store.get(countSetting)).toBe(3);
  });

  it('组内改一个 key 时,用组内其余 key 当前值整组 refine;违反跨字段约束则拒绝', () => {
    const store = makeStore({ groups: [agentLimitsGroup] });
    // 先把 maxConcurrentSubagents 设为 8(默认 maxSubagents=16,8≤16 合法)
    store.set(maxConcurrentSubagentsSetting, 8);
    // 再把 maxSubagents 改成 4 → 整组 8 ≤ 4 不成立 → 拒绝
    expect(() => store.set(maxSubagentsSetting, 4))
      .toThrow(InvalidSettingGroupValueError);
    // 未落库:仍是默认 16
    expect(store.get(maxSubagentsSetting)).toBe(16);
  });

  it('组内合法组合正常通过并落库', () => {
    const store = makeStore({ groups: [agentLimitsGroup] });
    store.set(maxSubagentsSetting, 8);
    store.set(maxConcurrentSubagentsSetting, 4); // 4 ≤ 8 → 通过
    expect(store.get(maxConcurrentSubagentsSetting)).toBe(4);
  });

  it('setMany 提交一组时整组校验;组内未改动 key 用当前值', () => {
    const store = makeStore({ groups: [agentLimitsGroup] });
    store.set(maxSubagentsSetting, 16);
    // 同一批:maxSubagents=2, maxConcurrentSubagents=4 → 4 > 2 拒绝
    expect(() =>
      store.setMany([
        { definition: maxSubagentsSetting, value: 2 },
        { definition: maxConcurrentSubagentsSetting, value: 4 },
      ]),
    ).toThrow(InvalidSettingGroupValueError);
    // 未落库
    expect(store.get(maxSubagentsSetting)).toBe(16);
  });

  it('目录职能:构造时注册定义,listDefinitions 带 schema 且按 key 排序,findDefinition 可查', () => {
    const store = makeStore({
      definitions: [countSetting, maxSubagentsSetting],
      groups: [agentLimitsGroup],
    });

    const list = store.listDefinitions();
    expect(list.map(d => d.key)).toEqual([
      'agent.limits.maxSubagents',
      'test.count',
    ]);
    expect(list[0]!.schema).toBe(maxSubagentsSetting.schema);
    expect(list[0]!.defaultValue).toBe(16);
    expect(list[0]!.group).toBe('agent.limits');

    expect(store.findDefinition('test.count')).toBe(countSetting);
    expect(store.findDefinition('no.such.key')).toBeUndefined();
  });

  it('注册重复 key 启动期 fail-fast', () => {
    const store = makeStore({ definitions: [countSetting] });
    expect(() => store.register(countSetting)).toThrow('Duplicate setting key');
  });
});

