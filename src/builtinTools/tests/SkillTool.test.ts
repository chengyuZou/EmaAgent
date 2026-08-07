// SkillTool 收口测试:池门控、描述符查找、全文有界读取、$ARGUMENTS 渲染、
// 未命中带可用清单、前导斜杠兼容。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type { ToolInvocation } from '@ema-agent/tools';
import { freezeSkillPool, type SkillDescriptor } from '@ema-agent/skills';
import { SkillTool } from '../tools/SkillTool/SkillTool.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeInvocation(): ToolInvocation {
  return {
    sessionId: asSessionId('00000000-0000-4000-8000-0000000000d1'),
    turnId: asTurnId('00000000-0000-4000-8000-0000000000d2'),
    toolCallId: asToolCallId('call-skill-1'),
    signal: new AbortController().signal,
  };
}

function plantSkill(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ema-skilltool-'));
  dirs.push(dir);
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\nversion: 2.1.0\ndescription: ${name} 说明书\nwhen-to-use: 做 ${name} 时\n---\n${body}`,
  );
  return join(dir, name);
}

function poolOf(entries: SkillDescriptor[]) {
  return freezeSkillPool({
    entries,
    disabledKeys: [],
    disabledProjectSources: [],
    builtinEnabled: true,
  });
}

function makeEntry(name: string, rootPath: string): SkillDescriptor {
  return {
    key: `user:${name}`,
    name,
    callName: name,
    version: '2.1.0',
    description: `${name} 说明书`,
    whenToUse: `做 ${name} 时`,
    allowedToolPatterns: [],
    rootPath,
    scope: 'user',
  };
}

describe('SkillTool', () => {
  it('无技能池时不可见(子 Agent/chat 态)', () => {
    expect(SkillTool.validateContext({} as never).valid).toBe(false);
  });

  it('命中技能:返回元数据 + 渲染后全文,frontmatter 不进 instructions', async () => {
    const root = plantSkill('code-review', '按清单逐条评审。');
    const pool = poolOf([makeEntry('code-review', root)]);
    const projection = SkillTool.validateContext({ skillPool: pool } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const result = await SkillTool.execute(
      { skill: 'code-review', args: undefined },
      projection.context,
      makeInvocation(),
    );

    expect(result).toMatchObject({
      callName: 'code-review',
      version: '2.1.0',
      rootPath: root,
      instructions: '按清单逐条评审。',
    });
    expect(result.instructions).not.toContain('---');
  });

  it('$ARGUMENTS 全量替换;无占位符时追加到末尾', async () => {
    const withPlaceholder = plantSkill('review-x', '评审 $ARGUMENTS 这部分。');
    const without = plantSkill('review-y', '自由评审。');
    const pool = poolOf([
      makeEntry('review-x', withPlaceholder),
      makeEntry('review-y', without),
    ]);
    const projection = SkillTool.validateContext({ skillPool: pool } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const replaced = await SkillTool.execute(
      { skill: 'review-x', args: '登录模块' },
      projection.context,
      makeInvocation(),
    );
    expect(replaced.instructions).toBe('评审 登录模块 这部分。');

    const appended = await SkillTool.execute(
      { skill: 'review-y', args: '只看 src/' },
      projection.context,
      makeInvocation(),
    );
    expect(appended.instructions).toBe('自由评审。\n\n只看 src/');
  });

  it('前导斜杠兼容;未命中报可用清单', async () => {
    const root = plantSkill('tdd', '先写测试。');
    const pool = poolOf([makeEntry('tdd', root)]);
    const projection = SkillTool.validateContext({ skillPool: pool } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const ok = await SkillTool.execute(
      { skill: '/tdd', args: undefined },
      projection.context,
      makeInvocation(),
    );
    expect(ok.name).toBe('tdd');

    await expect(
      SkillTool.execute({ skill: 'nope', args: undefined }, projection.context, makeInvocation()),
    ).rejects.toThrow(/Unknown skill: nope.*tdd/);
  });
});
