import type { AskUserQuestionSpec } from '@ema-agent/contracts';
import type { AgentTask, TaskStatus } from './types.js';
import { TranscriptJournal, journalPathFor } from './journal.js';

// ── AgentTaskStore ────────────────────────────────────────────────────────────
//
// Cross-session singleton: every agent turn (root + subagent) registers here.
//
// Concurrency model: JS is single-threaded. claim() is synchronous — it checks
// and inserts in the same microtask tick, so no two concurrent awaits can race
// on the same taskId.
//
// Cross-session behaviour:
//   - Each session's turns get independent task entries.
//   - Two sessions running simultaneously → two separate tasks, no conflict.
//   - listRunning() lets the UI/orchestrator see all active tasks globally.
//
// Crash recovery: every status transition appends a JSONL line before returning.
// scanAndRecover() reads those files at startup.

export class AgentTaskStore {
  private readonly tasks   = new Map<string, AgentTask>();
  private readonly journals = new Map<string, TranscriptJournal>();

  // ── Claim ─────────────────────────────────────────────────────────────────

  /**
   * Atomically create and register a task. Idempotent: if taskId already exists
   * (e.g. duplicate RPC), returns the existing task unchanged.
   *
   * @param taskId     Unique task id — use turnId for root tasks, UUID for subagents.
   * @param sessionId  Owning session.
   * @param turnId     DB turn id, or null for subagent tasks.
   * @param parentId   Parent task id, or null for root tasks.
   * @param dataDir    App data directory used to derive the journal path.
   */
  claim(args: {
    taskId:    string;
    sessionId: string;
    turnId:    string | null;
    parentId:  string | null;
    dataDir:   string;
  }): AgentTask {
    const existing = this.tasks.get(args.taskId);
    if (existing) return existing;

    const jPath   = journalPathFor(args.dataDir, args.sessionId, args.taskId);
    const journal = new TranscriptJournal(jPath);

    const task: AgentTask = {
      id:          args.taskId,
      sessionId:   args.sessionId,
      turnId:      args.turnId,
      parentId:    args.parentId,
      status:      'running',
      createdAt:   Date.now(),
      updatedAt:   Date.now(),
      journalPath: jPath,
    };

    this.tasks.set(args.taskId, task);
    this.journals.set(args.taskId, journal);

    journal.append({
      type:      'task_created',
      taskId:    task.id,
      sessionId: task.sessionId,
      turnId:    task.turnId,
      parentId:  task.parentId,
      ts:        task.createdAt,
    });
    journal.append({ type: 'task_started', ts: task.createdAt });

    return task;
  }

  // ── Status transitions ────────────────────────────────────────────────────

  /** Transition to waiting_user — persists promptId + questions for crash recovery. */
  waitUser(taskId: string, promptId: string, questions: AskUserQuestionSpec[]): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status            = 'waiting_user';
    task.pendingPromptId   = promptId;
    task.pendingQuestions  = questions;
    task.updatedAt         = Date.now();
    this.journals.get(taskId)?.append({
      type: 'task_waiting_user', promptId, questions, ts: task.updatedAt,
    });
  }

  /** Called when the user submits answers. Clears pending state, resumes loop. */
  userAnswered(taskId: string, promptId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status           = 'running';
    task.pendingPromptId  = undefined;
    task.pendingQuestions = undefined;
    task.updatedAt        = Date.now();
    this.journals.get(taskId)?.append({
      type: 'task_user_answered', promptId, ts: task.updatedAt,
    });
    this.journals.get(taskId)?.append({
      type: 'task_resumed', ts: task.updatedAt,
    });
  }

  complete(taskId: string, stats: { iterations: number; inputTokens: number; outputTokens: number }): void {
    this._terminal(taskId, 'completed');
    this.journals.get(taskId)?.append({ type: 'task_completed', ...stats, ts: Date.now() });
  }

  fail(taskId: string, reason: string): void {
    this._terminal(taskId, 'failed', reason);
    this.journals.get(taskId)?.append({ type: 'task_failed', reason, ts: Date.now() });
  }

  cancel(taskId: string, reason: string): void {
    this._terminal(taskId, 'cancelled', reason);
    this.journals.get(taskId)?.append({ type: 'task_cancelled', reason, ts: Date.now() });
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  get(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  listForSession(sessionId: string): AgentTask[] {
    return [...this.tasks.values()].filter(t => t.sessionId === sessionId);
  }

  listRunning(): AgentTask[] {
    return [...this.tasks.values()].filter(
      t => t.status === 'running' || t.status === 'waiting_user',
    );
  }

  // ── Startup crash recovery ────────────────────────────────────────────────

  /**
   * Scan all JSONL files under dataDir, reconstruct task state, and return a
   * report of interrupted tasks. Called once at app startup before any turn runs.
   *
   * Recovery rules:
   *   status=running      → mark failed (process died mid-loop)
   *   status=waiting_user → restore pendingPromptId/pendingQuestions so the
   *                         UI can re-show the question widget
   *   status=completed/failed/cancelled → load into memory for history queries,
   *                                       no action needed
   */
  recoverInterrupted(dataDir: string): {
    recovered: AgentTask[];
    waitingUser: AgentTask[];
  } {
    const recovered:   AgentTask[] = [];
    const waitingUser: AgentTask[] = [];

    const allJournals = collectJournalPaths(dataDir);

    for (const { sessionId, taskId, filePath } of allJournals) {
      if (this.tasks.has(taskId)) continue; // already loaded

      const journal = new TranscriptJournal(filePath);
      const entries = journal.readAll();
      if (entries.length === 0) continue;

      const task = replayJournal(taskId, sessionId, filePath, entries);
      if (!task) continue;

      this.tasks.set(taskId, task);
      this.journals.set(taskId, journal);

      if (task.status === 'running') {
        task.status    = 'failed';
        task.error     = 'Process terminated unexpectedly';
        task.updatedAt = Date.now();
        journal.append({ type: 'task_failed', reason: 'unexpected_shutdown', ts: task.updatedAt });
        recovered.push(task);
      } else if (task.status === 'waiting_user') {
        waitingUser.push(task);
      }
    }

    return { recovered, waitingUser };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private _terminal(taskId: string, status: Extract<TaskStatus, 'completed' | 'failed' | 'cancelled'>, error?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status    = status;
    task.error     = error;
    task.updatedAt = Date.now();
  }
}

// ── Journal replay ────────────────────────────────────────────────────────────

function replayJournal(
  taskId:    string,
  sessionId: string,
  filePath:  string,
  entries:   ReturnType<TranscriptJournal['readAll']>,
): AgentTask | null {
  const created = entries.find(e => e.type === 'task_created');
  if (!created || created.type !== 'task_created') return null;

  const task: AgentTask = {
    id:          taskId,
    sessionId,
    turnId:      created.turnId,
    parentId:    created.parentId,
    status:      'pending',
    createdAt:   created.ts,
    updatedAt:   created.ts,
    journalPath: filePath,
  };

  for (const e of entries) {
    task.updatedAt = e.ts;
    switch (e.type) {
      case 'task_started':
        task.status = 'running';
        break;
      case 'task_waiting_user':
        task.status           = 'waiting_user';
        task.pendingPromptId  = e.promptId;
        task.pendingQuestions = e.questions;
        break;
      case 'task_resumed':
        task.status           = 'running';
        task.pendingPromptId  = undefined;
        task.pendingQuestions = undefined;
        break;
      case 'task_completed':
        task.status = 'completed';
        break;
      case 'task_failed':
        task.status = 'failed';
        task.error  = e.reason;
        break;
      case 'task_cancelled':
        task.status = 'cancelled';
        task.error  = e.reason;
        break;
    }
  }

  return task;
}

// ── JSONL discovery ───────────────────────────────────────────────────────────

import * as fs   from 'node:fs';
import * as path from 'node:path';

interface JournalRef { sessionId: string; taskId: string; filePath: string }

function collectJournalPaths(dataDir: string): JournalRef[] {
  const sessionsRoot = path.join(dataDir, '.ema-agent', 'sessions');
  const refs: JournalRef[] = [];

  let sessionDirs: fs.Dirent[];
  try {
    sessionDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const sdir of sessionDirs) {
    if (!sdir.isDirectory()) continue;
    const sessionId  = sdir.name;
    const tasksDir   = path.join(sessionsRoot, sessionId, 'tasks');
    let taskFiles: fs.Dirent[];
    try {
      taskFiles = fs.readdirSync(tasksDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const tfile of taskFiles) {
      if (!tfile.isFile() || !tfile.name.endsWith('.jsonl')) continue;
      const taskId = tfile.name.slice(0, -'.jsonl'.length);
      refs.push({ sessionId, taskId, filePath: path.join(tasksDir, tfile.name) });
    }
  }

  return refs;
}
