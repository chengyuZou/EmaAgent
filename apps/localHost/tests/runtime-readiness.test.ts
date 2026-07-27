// 测试 LocalHost 只在协议一致时原子发布就绪记录，并在退出时清理记录。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishRuntimeReady } from '../src/bootstrap/readiness.js';

const originalEnvironment = { ...process.env };
const temporaryDirectories: string[] = [];

afterEach(() => {
  process.env = { ...originalEnvironment };
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('LocalHost 桌面运行时就绪协议', () => {
  it('写入 PID、端口、nonce 和协议版本，并允许清理', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ema-local-host-ready-'));
    temporaryDirectories.push(directory);
    const readyFile = path.join(directory, 'local-host.ready.json');
    process.env['EMA_READY_FILE'] = readyFile;
    process.env['EMA_RUNTIME_NONCE'] = 'runtime-nonce';
    process.env['EMA_RUNTIME_PROTOCOL_VERSION'] = '1';

    const cleanup = publishRuntimeReady(7314);
    const record = JSON.parse(readFileSync(readyFile, 'utf8')) as Record<string, unknown>;

    expect(record).toMatchObject({
      service: 'local-host',
      pid: process.pid,
      port: 7314,
      nonce: 'runtime-nonce',
      protocolVersion: 1,
    });
    expect(cleanup).not.toBeNull();
    cleanup?.();
    expect(() => readFileSync(readyFile)).toThrow();
  });

  it('拒绝桌面宿主不兼容的协议版本', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ema-local-host-ready-'));
    temporaryDirectories.push(directory);
    process.env['EMA_READY_FILE'] = path.join(directory, 'local-host.ready.json');
    process.env['EMA_RUNTIME_NONCE'] = 'runtime-nonce';
    process.env['EMA_RUNTIME_PROTOCOL_VERSION'] = '2';

    expect(() => publishRuntimeReady(7314)).toThrow('runtime protocol mismatch');
  });
});
