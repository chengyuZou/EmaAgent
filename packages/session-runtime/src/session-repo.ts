/**
 * 会话仓储接口。
 *
 * @remarks
 * 抽象层，屏蔽底层是 SQLite 还是 PostgreSQL 的实现差异。
 * 具体实现由 {@link storage-sql} 包提供并注入。
 */

import type { SessionRepository, TurnRepository } from "@ema-agent/core-types";

/** session-runtime 需要的组合仓储能力。 */
export type SessionRuntimeRepository = SessionRepository & TurnRepository;

let repoInstance: SessionRuntimeRepository | null = null;

/** 注入仓储实现 */
export function bindSessionRepository(repo: SessionRuntimeRepository): void {
  repoInstance = repo;
}

/** 获取当前绑定的仓储实例 */
export function getSessionRepository(): SessionRuntimeRepository {
  if (!repoInstance) {
    throw new Error("SessionRepository not bound. Call bindSessionRepository() first.");
  }
  return repoInstance;
}
