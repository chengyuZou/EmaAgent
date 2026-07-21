import type { MarketSourcesRepo, MarketSourceRow } from '@ema-agent/storage';
import type { MarketSourceRecord, MarketSourceSeed } from './types.js';
import { rowToRecord } from './types.js';

// ── MarketSourceStore ─────────────────────────────────────────────────────────
//
// 通用 DB CRUD,按 kind 过滤。不绑业务 —— 任何 kind 的源都走这里。
// builtin 源不可删(抛错),只能启停。ensureSeeds 启动时幂等 seed builtin 源。

export class MarketSourceStore {
  constructor(private readonly repo: MarketSourcesRepo) {}

  /** 列源,可按 kind 过滤。 */
  list(kind?: string): MarketSourceRecord[] {
    const rows = kind ? this.repo.listByKind(kind) : this.repo.listAll();
    return rows.map(rowToRecord);
  }

  /** 列某 kind 的所有 enabled 源(registry 聚合用)。 */
  listEnabled(kind: string): MarketSourceRecord[] {
    return this.repo.listEnabledByKind(kind).map(rowToRecord);
  }

  get(id: string): MarketSourceRecord | undefined {
    const row = this.repo.findById(id);
    return row ? rowToRecord(row) : undefined;
  }

  create(input: {
    id:        string;
    kind:      string;
    type:      string;
    label:     string;
    config:    string;
    builtin?:  boolean;
    sortOrder?: number;
  }): MarketSourceRecord {
    const now = Date.now();
    const row: MarketSourceRow = {
      id:         input.id,
      kind:       input.kind,
      type:       input.type,
      label:      input.label,
      config:     input.config,
      enabled:    1,
      builtin:    input.builtin ? 1 : 0,
      sort_order: input.sortOrder ?? 0,
      created_at: now,
    };
    this.repo.insert(row);
    return rowToRecord(row);
  }

  update(id: string, patch: {
    label?:     string;
    config?:    string;
    enabled?:   boolean;
    sortOrder?: number;
  }): MarketSourceRecord | undefined {
    this.repo.update(id, {
      label:     patch.label,
      config:    patch.config,
      enabled:   patch.enabled === undefined ? undefined : (patch.enabled ? 1 : 0),
      sort_order: patch.sortOrder,
    });
    return this.get(id);
  }

  /** 启停源。 */
  setEnabled(id: string, enabled: boolean): MarketSourceRecord | undefined {
    this.repo.update(id, { enabled: enabled ? 1 : 0 });
    return this.get(id);
  }

  /** 删源。builtin 拒绝(只能启停)。 */
  remove(id: string): void {
    const row = this.repo.findById(id);
    if (!row) return;
    if (row.builtin === 1) {
      throw new Error(`Cannot delete builtin market source "${id}" — disable it instead`);
    }
    this.repo.deleteById(id);
  }

  /**
   * 启动时幂等 seed builtin 源:已存在(按 id)则跳过,不存在则 insert。
   * 不会重复 insert —— 避免重启 UNIQUE 冲突。用户对 builtin 源的启停/排序
   * 不会被 seed 覆盖(只检查 id 存在性,不更新已有行)。
   */
  ensureSeeds(seeds: readonly MarketSourceSeed[]): void {
    const now = Date.now();
    for (const seed of seeds) {
      if (this.repo.findById(seed.id)) continue;
      this.repo.insert({
        id:         seed.id,
        kind:       seed.kind,
        type:       seed.type,
        label:      seed.label,
        config:     seed.config,
        enabled:    1,
        builtin:    1,
        sort_order: seed.sortOrder,
        created_at: now,
      });
    }
  }
}
