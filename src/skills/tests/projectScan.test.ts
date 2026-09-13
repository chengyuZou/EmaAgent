// project 扫描测试:多个源文件夹、生态目录发现、dotfiles/symlink 与深度边界。
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanProjectSkills } from '../sources/project.js';

const SKILL_MD = (name: string) =>
  `---\nname: ${name}\nversion: 1.0.0\ndescription: ${name} desc\n---\n# ${name}\n`;

const dirs: string[] = [];
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ema-skill-project-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function plantSkill(workspace: string, ecoRelDir: string, skillDir: string, name: string): void {
  const dir = join(workspace, ecoRelDir, skillDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD(name));
}

describe('scanProjectSkills', () => {
  it('发现生态目录里的技能并给出绝对 SKILL.md path 与来源', async () => {
    const ws = makeWorkspace();
    plantSkill(ws, '.agents/skills', 'code-review', 'code-review');
    plantSkill(ws, '.claude/skills', 'tdd', 'tdd');

    const result = await scanProjectSkills([ws]);
    expect(result.map(d => d.path).sort()).toEqual([
      join(ws, '.agents/skills', 'code-review', 'SKILL.md'),
      join(ws, '.claude/skills', 'tdd', 'SKILL.md'),
    ].sort());
    expect(result.map(d => d.projectSourceId).sort()).toEqual(['agents', 'claude']);
    expect(result.every((d) => d.scope === 'project')).toBe(true);
    expect(result.every((d) => d.sourceFolderPath === ws)).toBe(true);
  });

  it('allowed-tools 为字符串时仍列出技能,目录不投递该字段', async () => {
    const ws = makeWorkspace();
    const dir = join(ws, '.agents/skills', 'agent-browser');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: agent-browser\ndescription: Browser tasks\nallowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)\n---\n# Browser\n',
    );

    const result = await scanProjectSkills([ws]);
    expect(result).toMatchObject([
      {
        name: 'agent-browser',
        description: 'Browser tasks',
        scope: 'project',
      },
    ]);
    expect(Object.hasOwn(result[0]!, 'suggestedTools')).toBe(false);
    expect(Object.hasOwn(result[0]!, 'version')).toBe(false);
  });

  it('合并多个文件夹并保留每条技能的实际出处', async () => {
    const first = makeWorkspace();
    const second = makeWorkspace();
    plantSkill(first, '.agents/skills', 'alpha', 'alpha');
    plantSkill(second, '.agents/skills', 'beta', 'beta');

    const result = await scanProjectSkills([first, second]);
    expect(result.map((entry) => [entry.name, entry.sourceFolderPath])).toEqual([
      ['alpha', first],
      ['beta', second],
    ]);
  });

  it('dotfiles 目录不扫描', async () => {
    const ws = makeWorkspace();
    plantSkill(ws, '.agents/skills', 'visible', 'visible');
    plantSkill(ws, '.agents/skills', '.hidden/hidden-skill', 'hidden-skill');

    const result = await scanProjectSkills([ws]);
    expect(result.map((d) => d.name)).toEqual(['visible']);
  });

  it('symlink 目录不跟随', async (ctx) => {
    const ws = makeWorkspace();
    const outside = makeWorkspace();
    plantSkill(outside, '.', 'real-skill', 'real-skill');
    mkdirSync(join(ws, '.agents/skills'), { recursive: true });
    try {
      symlinkSync(join(outside, 'real-skill'), join(ws, '.agents/skills', 'linked'), 'dir');
    } catch {
      // Windows 无开发者模式/提权时不能创建 symlink;该环境跳过。
      ctx.skip();
    }

    const result = await scanProjectSkills([ws]);
    expect(result).toEqual([]);
  });

  it('超深度(>6)的 SKILL.md 不被发现', async () => {
    const ws = makeWorkspace();
    plantSkill(ws, '.agents/skills', 'a/b/c/d/e/f/g/deep-skill', 'deep-skill');
    const result = await scanProjectSkills([ws]);
    expect(result).toEqual([]);
  });
});
