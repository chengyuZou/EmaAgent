// 验证一根 Turn 只读取共享记忆、当前角色记忆和涉及该角色的完整关系段落。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRelationshipMemoryForTurn } from '../relationship/readForTurn.js';

describe('readRelationshipMemoryForTurn', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-relationship-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('按共享、当前角色、角色关系的顺序注入全文，关系段落可由标题或正文命中', async () => {
    await fs.mkdir(path.join(directory, 'characters', '艾玛'), { recursive: true });
    await fs.mkdir(path.join(directory, 'characters', '茉莉'), { recursive: true });
    await fs.mkdir(path.join(directory, 'characters', '艾玛', 'history'));
    await fs.writeFile(path.join(directory, 'shared_user_memory.md'), '用户共同边界\n第二行', 'utf8');
    await fs.writeFile(path.join(directory, 'characters', '艾玛', 'MEMORY.md'), '艾玛专属称呼', 'utf8');
    await fs.writeFile(path.join(directory, 'characters', '茉莉', 'MEMORY.md'), '茉莉专属称呼', 'utf8');
    await fs.writeFile(path.join(directory, 'characters', '艾玛', 'history', '2026-09-23.md'), '历史细节按需读取', 'utf8');
    await fs.writeFile(path.join(directory, 'character_relations.md'), [
      '# 角色关系',
      '前言不属于二级标题段落',
      '## 艾玛与茉莉',
      '标题命中的完整第一段',
      '仍属于第一段',
      '## 茉莉的回忆',
      '正文提到艾玛，完整第二段也应注入',
      '## 其他角色',
      '只有其他角色的故事',
    ].join('\n'), 'utf8');

    const text = await readRelationshipMemoryForTurn(directory, '艾玛');

    expect(text).toContain('用户共同边界\n第二行');
    expect(text).toContain('艾玛专属称呼');
    expect(text).toContain('## 艾玛与茉莉\n标题命中的完整第一段\n仍属于第一段');
    expect(text).toContain('## 茉莉的回忆\n正文提到艾玛，完整第二段也应注入');
    expect(text).not.toContain('茉莉专属称呼');
    expect(text).not.toContain('历史细节按需读取');
    expect(text).not.toContain('## 其他角色');
    expect(text).not.toContain('前言不属于二级标题段落');
    expect(text!.indexOf('用户共同边界')).toBeLessThan(text!.indexOf('艾玛专属称呼'));
    expect(text!.indexOf('艾玛专属称呼')).toBeLessThan(text!.indexOf('## 艾玛与茉莉'));
  });

  it('文件不存在时省略该段；无任何正式记忆时不注入', async () => {
    expect(await readRelationshipMemoryForTurn(directory, '艾玛')).toBeUndefined();
    await fs.writeFile(path.join(directory, 'character_relations.md'), '## 其他角色\n没有当前角色', 'utf8');
    expect(await readRelationshipMemoryForTurn(directory, '艾玛')).toBeUndefined();
    await fs.writeFile(path.join(directory, 'shared_user_memory.md'), '只有共享内容', 'utf8');
    expect(await readRelationshipMemoryForTurn(directory, '艾玛')).toContain('只有共享内容');
  });
});
