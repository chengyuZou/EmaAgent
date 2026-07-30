// 测试附件异步有界读取、小图片内联及大图或缺失文件的路径降级。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveForPrompt } from './resolver.js';
import type { Attachment } from './types.js';

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-resolver-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function att(file: string, size: number, mime = 'image/png'): Attachment {
  return {
    id: 'a1', turnId: 't1', sessionId: 's1',
    name: path.basename(file), mime, size, mtime: 1,
    localPath: file, createdAt: 1,
  };
}

describe('B-071 tryInlineImage 用 stat 真实 size 不信任客户端', () => {
  it('真实小图片 inline 为 image_data', async () => {
    const f = path.join(dir, 'small.png');
    fs.writeFileSync(f, Buffer.alloc(100, 1));
    const r = await resolveForPrompt([att(f, 100)]);
    expect(r.imageParts).toHaveLength(1);
    expect(r.imageParts[0]!.type).toBe('image_data');
  });

  it('伪造小 size 但实际 >5MB 时按真实文件大小降级路径引用', async () => {
    const f = path.join(dir, 'big.png');
    fs.writeFileSync(f, Buffer.alloc(6 * 1024 * 1024, 1));   // 真实 6MB
    const r = await resolveForPrompt([att(f, 100)]);         // 客户端伪造 size=100
    expect(r.imageParts).toHaveLength(0);                    // stat 真实 6MB > 5MB,不 inline
    expect(r.promptLines).toContain(f);                      // 降级路径引用
  });

  it('文件不存在时降级路径引用', async () => {
    const f = path.join(dir, 'missing.png');
    const r = await resolveForPrompt([att(f, 100)]);
    expect(r.imageParts).toHaveLength(0);
    expect(r.promptLines).toContain('not found');
  });
});
