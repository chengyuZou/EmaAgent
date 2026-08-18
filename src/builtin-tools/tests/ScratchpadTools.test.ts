// Scratchpad 五件套收口测试:Context 门控、invocation.signal 透传、真实临时目录 roundtrip、
// key 约束与配额语义经由 Tool 表面生效。引擎并发/原子性由 ScratchpadStore.test.ts 覆盖,此处不重复。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolInvocation } from '@ema-agent/tools';
import {
  ScratchpadClearTool,
  ScratchpadDeleteTool,
  ScratchpadListTool,
  ScratchpadReadTool,
  ScratchpadWriteTool,
} from '../tools/ScratchpadTool/ScratchpadTools.js';

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ema-scratchpad-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeInvocation(signal?: AbortSignal): ToolInvocation {
  return {
    sessionId: '00000000-0000-4000-8000-0000000000c1',
    turnId: '00000000-0000-4000-8000-0000000000c2',
    toolCallId: 'call-scratchpad-1',
    signal: signal ?? new AbortController().signal,
  };
}

// 五件套共用同一个 validateScratchpad;经 Write 投影一次即可代表全族。
function project(dir: string) {
  const projection = ScratchpadWriteTool.validateContext({
    scratchpad: { dir, author: 'main' },
  } as never);
  if (!projection.valid) throw new Error('投影应成功');
  return projection.context;
}

describe('Scratchpad Context 门控', () => {
  it('缺 scratchpad port 时五件套全部不可见(chat Turn)', () => {
    for (const tool of [
      ScratchpadWriteTool,
      ScratchpadReadTool,
      ScratchpadListTool,
      ScratchpadDeleteTool,
      ScratchpadClearTool,
    ]) {
      expect(tool.validateContext({} as never).valid).toBe(false);
    }
  });
});

describe('Scratchpad 五件套 roundtrip', () => {
  it('write → read → list → delete → clear 全链路', async () => {
    const ctx = project(makeDir());

    const written = await ScratchpadWriteTool.execute(
      { key: 'notes', value: 'hello', append: undefined },
      ctx,
      makeInvocation(),
    );
    expect(written.key).toBe('notes');
    expect(written.bytes).toBeGreaterThan(0);

    await ScratchpadWriteTool.execute(
      { key: 'notes', value: 'world', append: true },
      ctx,
      makeInvocation(),
    );

    const read = await ScratchpadReadTool.execute({ key: 'notes' }, ctx, makeInvocation());
    expect(read).toMatchObject({ value: 'hello\nworld' });

    const listed = await ScratchpadListTool.execute({}, ctx, makeInvocation());
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]).toMatchObject({ key: 'notes', author: 'main' });
    expect(listed.totalBytes).toBeGreaterThan(0);

    const deleted = await ScratchpadDeleteTool.execute({ key: 'notes' }, ctx, makeInvocation());
    expect(deleted.deleted).toBe(true);

    const missing = await ScratchpadReadTool.execute({ key: 'notes' }, ctx, makeInvocation());
    expect(missing).toEqual({ value: null });

    await ScratchpadWriteTool.execute(
      { key: 'a', value: '1', append: undefined },
      ctx,
      makeInvocation(),
    );
    const cleared = await ScratchpadClearTool.execute({}, ctx, makeInvocation());
    expect(cleared.cleared).toBe(1);
    expect((await ScratchpadListTool.execute({}, ctx, makeInvocation())).keys).toHaveLength(0);
  });

  it('未写入的 key 读取返回 value:null,删除返回 deleted:false', async () => {
    const ctx = project(makeDir());
    await expect(
      ScratchpadReadTool.execute({ key: 'nope' }, ctx, makeInvocation()),
    ).resolves.toEqual({ value: null });
    await expect(
      ScratchpadDeleteTool.execute({ key: 'nope' }, ctx, makeInvocation()),
    ).resolves.toEqual({ deleted: false });
  });

  it('write 把 invocation.signal 透传到引擎:已中止信号直接拒绝', async () => {
    const ctx = project(makeDir());
    const controller = new AbortController();
    controller.abort();

    await expect(
      ScratchpadWriteTool.execute(
        { key: 'x', value: 'y', append: undefined },
        ctx,
        makeInvocation(controller.signal),
      ),
    ).rejects.toThrow(/abort/i);
  });

  it('key 约束在 schema 层生效:路径穿越与非法字符进不了引擎', () => {
    for (const bad of ['../escape', 'a/b', 'a b', '', '中文key']) {
      expect(ScratchpadWriteTool.inputSchema.safeParse({ key: bad, value: 'v' }).success).toBe(false);
    }
    expect(
      ScratchpadWriteTool.inputSchema.safeParse({ key: 'research_summary-2', value: 'v' }).success,
    ).toBe(true);
  });
});
