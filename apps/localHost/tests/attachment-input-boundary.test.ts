// 测试 Turn HTTP 边界只接受文件能力句柄，不再接受前端提交的任意绝对路径。
import { describe, expect, it } from 'vitest';
import { attachmentInputSchema } from '../src/routes/turns/index.js';

const metadata = {
  id: 'attachment-1',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  size: 1024,
  mtime: 123,
};

describe('Turn attachment input boundary', () => {
  it('拒绝旧 localPath 请求', () => {
    const result = attachmentInputSchema.safeParse({
      ...metadata,
      localPath: 'D:\\private\\secret.txt',
    });
    expect(result.success).toBe(false);
  });

  it('只接受有界 fileHandle', () => {
    const result = attachmentInputSchema.safeParse({
      ...metadata,
      fileHandle: 'ema-file:v1:nonce:sealed',
    });
    expect(result.success).toBe(true);
  });
});
