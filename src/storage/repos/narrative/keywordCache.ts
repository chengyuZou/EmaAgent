import type { SqliteDb } from '../../database/database.js';

export interface NarrativeKeywords {
  highLevelKeywords: string[];
  lowLevelKeywords: string[];
}

interface NarrativeKeywordCacheRow {
  high_level_keywords: string;
  low_level_keywords: string;
}

export class NarrativeKeywordCacheRepo {
  constructor(private readonly db: SqliteDb) {}

  findByKey(cacheKey: string): NarrativeKeywords | undefined {
    const row = this.db.prepare(`
      SELECT high_level_keywords, low_level_keywords FROM keyword_cache WHERE cache_key = ?
    `).get(cacheKey) as NarrativeKeywordCacheRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      highLevelKeywords: JSON.parse(row.high_level_keywords) as string[],
      lowLevelKeywords: JSON.parse(row.low_level_keywords) as string[],
    };
  }

  upsert(cacheKey: string, highLevelKeywords: readonly string[], lowLevelKeywords: readonly string[]): void {
    this.db.prepare(`
      INSERT INTO keyword_cache (cache_key, high_level_keywords, low_level_keywords)
      VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        high_level_keywords = excluded.high_level_keywords,
        low_level_keywords = excluded.low_level_keywords
    `).run(cacheKey, JSON.stringify(highLevelKeywords), JSON.stringify(lowLevelKeywords));
  }
}
