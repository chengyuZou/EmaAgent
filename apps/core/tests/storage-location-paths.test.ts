// 这里测试 RuntimePaths 能否完整返回 SQLite 主文件及其 WAL/SHM 文件。

import { describe, expect, it } from 'vitest';
import { sqliteFileSet } from '../src/storage-locations/paths.js';

describe('sqliteFileSet', () => {
  it('返回同一个数据库对应的三个文件', () => {
    expect(sqliteFileSet('D:\\Ema Data\\profile.db')).toEqual([
      'D:\\Ema Data\\profile.db',
      'D:\\Ema Data\\profile.db-wal',
      'D:\\Ema Data\\profile.db-shm',
    ]);
  });
});
