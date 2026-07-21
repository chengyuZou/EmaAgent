// 测试附件模块区分原文件可用、已修改和已丢失三种磁盘状态。
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttachmentRepo } from '@ema-agent/storage';
import { AttachmentStore } from '../store.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(localPath: string, size: number, mtime: number): AttachmentStore {
  const repo = {
    listBySession: () => [{
      id: 'attachment-a',
      turn_id: 'turn-a',
      session_id: 'session-a',
      name: 'sample.txt',
      mime: 'text/plain',
      size,
      mtime,
      local_path: localPath,
      created_at: 1,
    }],
  } as unknown as AttachmentRepo;
  return new AttachmentStore(repo, { assertTurnOwnership: () => {} });
}

describe('AttachmentStore.inspectBySession', () => {
  it('识别仍与上传时一致的文件', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ema-attachment-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'sample.txt');
    writeFileSync(path, 'hello');
    const stat = statSync(path);

    const [result] = await createStore(path, stat.size, stat.mtimeMs).inspectBySession('session-a');
    expect(result?.fileStatus).toBe('available');
  });

  it('识别内容大小已变化的文件', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ema-attachment-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'sample.txt');
    writeFileSync(path, 'changed');
    const stat = statSync(path);

    const [result] = await createStore(path, stat.size - 1, stat.mtimeMs).inspectBySession('session-a');
    expect(result?.fileStatus).toBe('modified');
  });

  it('识别已不存在的原文件', async () => {
    const path = join(tmpdir(), `ema-missing-${Date.now()}.txt`);
    const [result] = await createStore(path, 1, 1).inspectBySession('session-a');
    expect(result?.fileStatus).toBe('missing');
  });
});
