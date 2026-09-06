import type { MemoryJob, MemoryRepo } from '@ema-agent/storage';

export async function runMaintenanceJob(
  jobs: MemoryRepo,
  job: MemoryJob,
  maintain: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (signal.aborted) return;
    await maintain();
    if (!signal.aborted) jobs.complete(job.id, Date.now());
  } catch (error) {
    if (!signal.aborted) jobs.fail(job.id, errorMessage(error), Date.now());
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
