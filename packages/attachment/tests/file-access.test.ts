// 测试文件能力句柄的跨重启解密、篡改防护与权威文件元数据读取。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAccessFacade } from '../src/file-access.js';

const MASTER_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileAccessFacade', () => {
  it('兼容 Rust Host 使用的固定协议向量', () => {
    const windowsHandle = 'ema-file:v1:AAECAwQFBgcICQoL:tARCk_QBynE6TmCEF8f4kOv6TpOeaOOtd6TKRZNX5wa8kvRPGnpNWPKHP0LDlo68Ez50';
    const unixHandle = 'ema-file:v1:AAECAwQFBgcICQoL:tARCk_QBynE6Ii61O73umPikZqqocayFU6SNS_X9qA42o--Uq3dVo1Lvzlk';
    const expectedPath = process.platform === 'win32'
      ? 'C:\\Users\\Ema\\test.txt'
      : '/tmp/ema-test.txt';
    const handle = process.platform === 'win32' ? windowsHandle : unixHandle;

    expect(new FileAccessFacade(MASTER_KEY).resolve(handle)).toBe(expectedPath);
  });

  it('另一实例可以用同一主密钥解析句柄', () => {
    const localPath = path.resolve('example.txt');
    const issued = new FileAccessFacade(MASTER_KEY).issue(localPath);
    expect(new FileAccessFacade(MASTER_KEY).resolve(issued)).toBe(localPath);
  });

  it('拒绝被篡改或由其他主密钥签发的句柄', () => {
    const facade = new FileAccessFacade(MASTER_KEY);
    const handle = facade.issue(path.resolve('example.txt'));
    const replacement = handle.endsWith('A') ? 'B' : 'A';
    expect(() => facade.resolve(`${handle.slice(0, -1)}${replacement}`)).toThrow('完整性校验');
    expect(() => new FileAccessFacade('ff'.repeat(32)).resolve(handle)).toThrow('完整性校验');
  });

  it('忽略前端伪造的文件名、大小和修改时间', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ema-file-access-'));
    temporaryDirectories.push(directory);
    const localPath = path.join(directory, 'trusted.txt');
    writeFileSync(localPath, 'trusted', 'utf8');
    const facade = new FileAccessFacade(MASTER_KEY);

    const prepared = facade.prepareAttachment({
      id: 'attachment-1',
      name: 'fake.png',
      mimeType: 'text/plain',
      size: 999_999,
      mtime: 1,
      fileHandle: facade.issue(localPath),
    });

    expect(prepared.name).toBe('trusted.txt');
    expect(prepared.size).toBe(7);
    expect(prepared.mtime).toBeGreaterThan(1);
    expect(prepared.localPath).toBe(localPath);
  });
});
