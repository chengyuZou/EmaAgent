// 测试 records 注册表:路径唯一、归属 records/、必需项与白名单一致性。
import { describe, expect, it } from 'vitest';
import {
  BACKUP_RECORD_PATHS,
  BACKUP_RECORD_REGISTRY,
  recordDefinition,
} from '../records/recordRegistry.js';

describe('BACKUP_RECORD_REGISTRY', () => {
  it('archivePath 全局唯一', () => {
    const paths = BACKUP_RECORD_REGISTRY.map((def) => def.archivePath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('全部条目位于 records/ 下,且与白名单集合一致', () => {
    for (const def of BACKUP_RECORD_REGISTRY) {
      expect(def.archivePath.startsWith('records/')).toBe(true);
      expect(BACKUP_RECORD_PATHS.has(def.archivePath)).toBe(true);
    }
    expect(BACKUP_RECORD_PATHS.size).toBe(BACKUP_RECORD_REGISTRY.length);
  });

  it('单对象 json 条目 maxRecords 恒为 1,只有 memoryState/sessionNotes 可缺省', () => {
    for (const def of BACKUP_RECORD_REGISTRY) {
      if (def.encoding === 'json') expect(def.maxRecords).toBe(1);
    }
    const optional = BACKUP_RECORD_REGISTRY.filter((def) => !def.required);
    expect(optional.map((def) => def.name).sort()).toEqual(['memoryState', 'sessionNotes']);
  });

  it('recordDefinition 查表命中,未注册名抛错', () => {
    expect(recordDefinition('turns').archivePath).toBe('records/turns.jsonl');
    expect(() => recordDefinition('nope' as never)).toThrow();
  });
});
