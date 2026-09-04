// SkillTool 收口测试:池门控、绝对路径查找、全文读取与未命中清单。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolInvocation } from '@ema-agent/tools';
import { freezeSkillPool, type SkillDescriptor } from '@ema-agent/skills';
import { SkillTool } from '../tools/SkillTool/SkillTool.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeInvocation(): ToolInvocation {
  return {
    sessionId: '00000000-0000-4000-8000-0000000000d1',
    turnId: '00000000-0000-4000-8000-0000000000d2',
    toolCallId: 'call-skill-1',
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
  return join(dir, name, 'SKILL.md');
}

function poolOf(entries: SkillDescriptor[]) {
  return freezeSkillPool({
    entries,
    disabledPaths: [],
    disabledProjectSources: [],
  });
}

function makeEntry(name: string, path: string): SkillDescriptor {
  return {
    name,
    path,
    version: '2.1.0',
    description: `${name} 说明书`,
    whenToUse: `做 ${name} 时`,
    suggestedTools: [],
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
      { name: 'code-review', path: root },
      projection.context,
      makeInvocation(),
    );

    expect(result).toMatchObject({
      name: 'code-review',
      version: '2.1.0',
      path: root,
      instructions: '按清单逐条评审。',
    });
    expect(result.instructions).not.toContain('---');
  });

  it('同名技能按绝对路径精确读取', async () => {
    const first = plantSkill('review', '第一份。');
    const second = plantSkill('review', '第二份。');
    const pool = poolOf([
      makeEntry('review', first),
      makeEntry('review', second),
    ]);
    const projection = SkillTool.validateContext({ skillPool: pool } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const result = await SkillTool.execute(
      { name: 'review', path: second },
      projection.context,
      makeInvocation(),
    );
    expect(result.instructions).toBe('第二份。');
  });

  it('未命中报可用清单', async () => {
    const root = plantSkill('tdd', '先写测试。');
    const pool = poolOf([makeEntry('tdd', root)]);
    const projection = SkillTool.validateContext({ skillPool: pool } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const ok = await SkillTool.execute(
      { name: 'tdd', path: root },
      projection.context,
      makeInvocation(),
    );
    expect(ok.name).toBe('tdd');

    await expect(
      SkillTool.execute({ name: 'nope', path: '/missing/SKILL.md' }, projection.context, makeInvocation()),
    ).rejects.toThrow(/Unknown skill path:.*tdd/);
  });
});
