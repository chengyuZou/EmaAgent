import type { KbIngestTasksRepo } from '@ema-agent/storage';
import type { IngestOptions } from '@ema-agent/knowledge-base';

export interface IngestQueueDeps {
  tasks:          KbIngestTasksRepo;
  ingest:         (filePath: string, opts: IngestOptions) => Promise<unknown>;
  /** Resolve the current embed/vision/rerank model options at run time (from
   *  app settings), so a task queued before a model change — or recovered after a
   *  restart — uses the model that's bound *now*. */
  resolveOptions: () => Partial<IngestOptions>;
  /** Max concurrent ingests. Keeps a 50-file drop from hammering the embed API. */
  concurrency?:   number;
}

/**
 * Concurrency-limited, persistent background ingest queue. Tasks live in
 * `kb_ingest_tasks` (survive restart); failures stay `failed` with their error so
 * the UI can offer retry. One JS thread + sync sqlite → claim is race-free.
 */
export class IngestQueue {
  private running = 0;
  private readonly concurrency: number;

  constructor(private readonly deps: IngestQueueDeps) {
    this.concurrency = deps.concurrency ?? 2;
  }

  /** Create a task and start draining (subject to the concurrency limit). */
  enqueue(t: { id: string; filePath: string; fileName: string; mimeType?: string }): void {
    this.deps.tasks.insert(t);
    this.tick();
  }

  /** Re-queue a failed task. Returns false if it isn't a failed task. */
  retry(id: string): boolean {
    const task = this.deps.tasks.get(id);
    if (!task || task.status !== 'failed') return false;
    this.deps.tasks.setPending(id);
    this.tick();
    return true;
  }

  /** Startup: recover crashed `running` tasks → failed, then drain any pending. */
  resume(): void {
    this.deps.tasks.recoverStuck();
    this.tick();
  }

  private tick(): void {
    while (this.running < this.concurrency) {
      const task = this.deps.tasks.claimNextPending();
      if (!task) break;
      this.running++;
      void this.run(task).finally(() => {
        this.running--;
        this.tick();
      });
    }
  }

  private async run(task: { id: string; filePath: string; mimeType?: string }): Promise<void> {
    try {
      await this.deps.ingest(task.filePath, {
        assetId:  task.id,
        mimeType: task.mimeType,
        ...this.deps.resolveOptions(),
      });
      this.deps.tasks.complete(task.id);
    } catch (err) {
      this.deps.tasks.fail(task.id, err instanceof Error ? err.message : String(err));
    }
  }
}
