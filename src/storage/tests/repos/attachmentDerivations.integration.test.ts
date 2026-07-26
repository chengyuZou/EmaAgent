// 测试图片 Vision 派生缓存的唯一身份、LRU 时间更新和级联删除。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AttachmentDerivationsRepo,
  Database,
} from '../../index.js';

describe('AttachmentDerivationsRepo', () => {
  let database: Database;
  let repo: AttachmentDerivationsRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    repo = new AttachmentDerivationsRepo(database.sqlite);
  });

  afterEach(() => database.close());

  it('按图片、任务、模型和 Prompt 版本唯一复用派生结果', () => {
    const identity = {
      contentSha256: 'a'.repeat(64),
      task: 'caption' as const,
      providerConfigId: 'provider-1',
      modelId: 'vision-1',
      promptSha256: 'b'.repeat(64),
      transformVersion: 'attachment-image-v1',
      language: '',
    };
    repo.save({
      contentSha256: identity.contentSha256,
      relativePath: 'attachments/vision-cache/aa/image.webp',
      mime: 'image/webp',
      byteSize: 100,
      width: 20,
      height: 10,
      now: 10,
    }, {
      id: 'derivation-1',
      ...identity,
      relativePath: 'attachments/vision-cache/aa/derivations/one.txt',
      byteSize: 20,
      now: 10,
    });

    expect(repo.find(identity)).toMatchObject({
      id: 'derivation-1',
      last_used_at: 10,
    });
    repo.touch('derivation-1', identity.contentSha256, 20);
    expect(repo.find(identity)?.last_used_at).toBe(20);

    repo.deleteDerivation('derivation-1');
    expect(repo.find(identity)).toBeUndefined();
    expect(repo.findUnreferencedImages(10)).toHaveLength(1);
    repo.deleteImage(identity.contentSha256);
    expect(repo.totalBytes()).toBe(0);
  });
});
