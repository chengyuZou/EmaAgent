// zip 解压校验测试:路径穿越、魔数、顶层目录剥离、SKILL.md 必需。
// 用 fflate zipSync 构造真实 zip 字节,不起网络、不落盘。
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { extractBundle } from '../installer/extract.js';

const SKILL_MD = `---\nname: demo\nversion: 1.0.0\ndescription: demo skill\n---\n# Demo\n`;

function makeZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const encoded: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    encoded[name] = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  }
  return zipSync(encoded);
}

describe('extractBundle — 正常形态', () => {
  it('内容根直接含 SKILL.md', () => {
    const bundle = extractBundle(makeZip({ 'SKILL.md': SKILL_MD, 'refs/a.md': '# ref' }));
    expect(Object.keys(bundle.files).sort()).toEqual(['SKILL.md', 'refs/a.md']);
  });

  it('单一顶层目录被剥离', () => {
    const bundle = extractBundle(makeZip({ 'pdf-qa/SKILL.md': SKILL_MD, 'pdf-qa/scripts/x.py': 'x' }));
    expect(Object.keys(bundle.files).sort()).toEqual(['SKILL.md', 'scripts/x.py']);
  });
});

describe('extractBundle — 防线', () => {
  it('拒绝非 zip 字节(魔数)', () => {
    expect(() => extractBundle(new TextEncoder().encode('not a zip file at all'))).toThrow(/魔数|zip/);
  });

  it('拒绝路径穿越条目', () => {
    expect(() => extractBundle(makeZip({ 'SKILL.md': SKILL_MD, '../evil.txt': 'x' })))
      .toThrow(/越界|路径/);
  });

  it('拒绝绝对路径与反斜杠', () => {
    expect(() => extractBundle(makeZip({ 'SKILL.md': SKILL_MD, '/abs.txt': 'x' })))
      .toThrow();
    expect(() => extractBundle(makeZip({ 'SKILL.md': SKILL_MD, 'a\\b.txt': 'x' })))
      .toThrow();
  });

  it('拒绝缺少 SKILL.md 的包', () => {
    expect(() => extractBundle(makeZip({ 'readme.md': 'hi' }))).toThrow(/SKILL\.md/);
  });

  it('顶层目录剥离后仍含路径穿越时拒绝', () => {
    expect(() => extractBundle(makeZip({ 'pkg/SKILL.md': SKILL_MD, 'pkg/../../evil': 'x' })))
      .toThrow();
  });
});
