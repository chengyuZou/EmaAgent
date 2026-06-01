import { randomUUID }            from 'node:crypto';
import type { McpServersRepo }   from '@ema-agent/storage';
import type { McpServerConfig, McpServerRecord } from './types.js';
import { McpServerConfigSchema } from './types.js';
import { McpServerNotFoundError } from './errors.js';

// ── McpServerStore ────────────────────────────────────────────────────────────
//
// Business-logic layer over McpServersRepo.
//
// Responsibilities:
//   - Parse/serialize McpServerConfig (JSON Schema validation)
//   - CRUD operations expressed in domain types (not raw DB rows)
//
// Does NOT manage connections — that is McpRegistry's job.

export class McpServerStore {
  constructor(private readonly repo: McpServersRepo) {}

  register(name: string, config: McpServerConfig, sourceUrl?: string): string {
    const existing = this.repo.findByName(name);
    if (existing) {
      this.repo.update(existing.id, {
        configJson: JSON.stringify(config),
        sourceUrl:  sourceUrl ?? null,
      });
      return existing.id;
    }
    const id = randomUUID();
    this.repo.insert({
      id,
      name,
      source_url:   sourceUrl ?? null,
      config_json:  JSON.stringify(config),
      enabled:      1,
      installed_at: Date.now(),
    });
    return id;
  }

  setEnabled(name: string, enabled: boolean): void {
    const row = this.repo.findByName(name);
    if (!row) throw new McpServerNotFoundError(name);
    this.repo.update(row.id, { enabled: enabled ? 1 : 0 });
  }

  remove(name: string): void {
    const row = this.repo.findByName(name);
    if (!row) return;
    this.repo.deleteById(row.id);
  }

  findByName(name: string): McpServerRecord | null {
    const row = this.repo.findByName(name);
    return row ? this.rowToRecord(row) : null;
  }

  listAll(): McpServerRecord[] {
    return this.repo.listAll().map((r) => this.rowToRecord(r));
  }

  listEnabled(): McpServerRecord[] {
    return this.repo.listEnabled().map((r) => this.rowToRecord(r));
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private rowToRecord(row: {
    id: string; name: string; source_url: string | null;
    config_json: string; enabled: number; installed_at: number;
  }): McpServerRecord {
    return {
      id:          row.id,
      name:        row.name,
      sourceUrl:   row.source_url ?? undefined,
      config:      McpServerConfigSchema.parse(JSON.parse(row.config_json)),
      enabled:     row.enabled === 1,
      installedAt: row.installed_at,
    };
  }
}
