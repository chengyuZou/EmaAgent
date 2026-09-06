import type {
  MemoryExtractionJobKind,
  MemoryRepo,
} from '@ema-agent/storage';
import { MEMORY_EXTRACTION_CONCURRENCY } from '../capacity/limits.js';
import type { ExtractTurn } from '../extractTurn.js';

export interface ExtractionRunStats {
  readonly claimed: number;
  readonly succeededWithOutput: number;
  readonly succeededWithoutOutput: number;
  readonly failed: number;
}

export async function runExtractionJobs(
  jobs: MemoryRepo,
  kind: MemoryExtractionJobKind,
  extractTurn: ExtractTurn,
  signal: AbortSignal,
): Promise<ExtractionRunStats> {
  const stats = {
    claimed: 0,
    succeededWithOutput: 0,
    succeededWithoutOutput: 0,
    failed: 0,
  };
  await Promise.all(Array.from(
    { length: MEMORY_EXTRACTION_CONCURRENCY },
    () => runWorker(jobs, kind, extractTurn, signal, stats),
  ));
  return stats;
}

async function runWorker(
  jobs: MemoryRepo,
  kind: MemoryExtractionJobKind,
  extractTurn: ExtractTurn,
  signal: AbortSignal,
  stats: {
    claimed: number;
    succeededWithOutput: number;
    succeededWithoutOutput: number;
    failed: number;
  },
): Promise<void> {
  while (!signal.aborted) {
    const job = jobs.claimNext(kind, Date.now());
    if (!job) return;
    stats.claimed += 1;
    const turnId = job.turnId!;
    try {
      const result = await extractTurn({ kind, turnId, signal });
      if (signal.aborted) return;
      if (!result) {
        if (jobs.complete(job.id, Date.now())) stats.succeededWithoutOutput += 1;
        continue;
      }
      const completed = kind === 'work_extraction'
        ? jobs.completeWorkExtraction(job.id, result.sessionId, result.content, Date.now())
        : jobs.completeRelationshipExtraction(
            job.id,
            result.sessionId,
            result.characterName!,
            result.content,
            Date.now(),
          );
      if (completed) stats.succeededWithOutput += 1;
    } catch (error) {
      if (signal.aborted) return;
      if (jobs.fail(job.id, errorMessage(error), Date.now())) stats.failed += 1;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
