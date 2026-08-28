// 后台进程面板状态:每 Session 列表、每进程有界输出缓存、SSE 事件原位更新、Session 删除清理。
import { create } from 'zustand';
import type {
  BackgroundProcessEvent,
} from '@ema-agent/tools';
import {
  backgroundProcessesApi,
  type BackgroundProcessStatus,
  type BackgroundProcessSummary,
} from '../api/backgroundProcesses.js';

/** 前端渲染缓冲封顶:与后端单次读取同量级,日志再大也不在前端堆内存。 */
const MAX_RENDERED_CHARS = 64 * 1024;
const FOLLOW_WAIT_MS = 3_000;

export interface ProcessListState {
  readonly processes: readonly BackgroundProcessSummary[];
  readonly status: 'loading' | 'ready' | 'error';
  readonly error?: string;
}

export interface ProcessOutputState {
  readonly stdout: string;
  readonly stderr: string;
  readonly cursor: string;
  readonly hasMore: boolean;
  /** 上游还有更多字节(后端 hasMore 或日志截断)——如实提示"只显示开头"。 */
  readonly loading: boolean;
  readonly followTail: boolean;
}

interface BackgroundProcessStore {
  readonly listsBySession: ReadonlyMap<string, ProcessListState>;
  readonly outputsById: ReadonlyMap<string, ProcessOutputState>;
  loadForSession(sessionId: string): Promise<void>;
  applyEvent(event: BackgroundProcessEvent): void;
  readOutput(sessionId: string, processId: string): Promise<void>;
  setFollowTail(sessionId: string, processId: string, follow: boolean): void;
  stop(sessionId: string, processId: string): Promise<void>;
  clearSession(sessionId: string): void;
}

/** 跟随尾部的长轮询循环不进 zustand 状态,避免 timer 句柄进快照。 */
const followTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelFollow(processId: string): void {
  const timer = followTimers.get(processId);
  if (timer !== undefined) clearTimeout(timer);
  followTimers.delete(processId);
}

function appendCapped(current: string, chunk: string): { text: string; } {
  const joined = current + chunk;
  return {
    text: joined.length > MAX_RENDERED_CHARS
      ? joined.slice(joined.length - MAX_RENDERED_CHARS)
      : joined,
  };
}

function isLive(status: BackgroundProcessStatus): boolean {
  return status === 'queued' || status === 'running';
}

export const useBackgroundProcessStore = create<BackgroundProcessStore>()((set, get) => ({
  listsBySession: new Map(),
  outputsById: new Map(),

  async loadForSession(sessionId) {
    set((state) => ({
      listsBySession: new Map(state.listsBySession).set(sessionId, {
        processes: state.listsBySession.get(sessionId)?.processes ?? [],
        status: 'loading',
      }),
    }));
    try {
      const { items } = await backgroundProcessesApi.list(sessionId, { limit: 100 });
      set((state) => ({
        listsBySession: new Map(state.listsBySession).set(sessionId, {
          processes: items,
          status: 'ready',
        }),
      }));
    } catch (error: unknown) {
      set((state) => ({
        listsBySession: new Map(state.listsBySession).set(sessionId, {
          processes: [],
          status: 'error',
          error: error instanceof Error ? error.message : '加载失败',
        }),
      }));
    }
  },

  applyEvent(event) {
    const sessionId = event.sessionId as string;
    const list = get().listsBySession.get(sessionId);
    if (!list) return; // 面板未加载该 Session 时不预取,等打开再拉。
    const processId = event.backgroundProcessId as string;
    const existing = list.processes.find((p) => (p.id as string) === processId);
    if (!existing) {
      // 新进程没有完整 summary,直接重拉列表。
      void get().loadForSession(sessionId);
      return;
    }
    const updated = list.processes.map((p) =>
      (p.id as string) === processId
        ? {
          ...p,
          status: event.status,
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
          ...(event.terminationReason !== undefined
            ? { terminationReason: event.terminationReason }
            : {}),
        }
        : p);
    set((state) => ({
      listsBySession: new Map(state.listsBySession).set(sessionId, {
        ...list,
        processes: updated,
      }),
    }));
  },

  async readOutput(sessionId, processId) {
    const key = processId;
    const current = get().outputsById.get(key);
    if (current?.loading) return;
    set((state) => ({
      outputsById: new Map(state.outputsById).set(key, {
        stdout: current?.stdout ?? '',
        stderr: current?.stderr ?? '',
        cursor: current?.cursor ?? '',
        hasMore: current?.hasMore ?? false,
        loading: true,
        followTail: current?.followTail ?? false,
      }),
    }));
    try {
      const result = await backgroundProcessesApi.readOutput(sessionId, processId, {
        ...(current?.cursor ? { cursor: current.cursor } : {}),
        ...(current?.followTail ? { waitMs: FOLLOW_WAIT_MS } : {}),
      });
      const stdout = appendCapped(current?.stdout ?? '', result.stdout);
      const stderr = appendCapped(current?.stderr ?? '', result.stderr);
      set((state) => ({
        outputsById: new Map(state.outputsById).set(key, {
          stdout: stdout.text,
          stderr: stderr.text,
          cursor: result.nextCursor,
          hasMore: result.hasMore,
          loading: false,
          followTail: current?.followTail ?? false,
        }),
      }));
      // 进程终态后停掉跟随循环。
      if (!isLive(result.process.status)) cancelFollow(processId);
    } catch {
      set((state) => ({
        outputsById: new Map(state.outputsById).set(key, {
          stdout: current?.stdout ?? '',
          stderr: current?.stderr ?? '',
          cursor: current?.cursor ?? '',
          hasMore: current?.hasMore ?? false,
          loading: false,
          followTail: false,
        }),
      }));
      cancelFollow(processId);
    }
  },

  setFollowTail(sessionId, processId, follow) {
    cancelFollow(processId);
    const current = get().outputsById.get(processId);
    set((state) => ({
      outputsById: new Map(state.outputsById).set(processId, {
        stdout: current?.stdout ?? '',
        stderr: current?.stderr ?? '',
        cursor: current?.cursor ?? '',
        hasMore: current?.hasMore ?? false,
        loading: current?.loading ?? false,
        followTail: follow,
      }),
    }));
    if (!follow) return;

    const tick = (): void => {
      if (!get().outputsById.get(processId)?.followTail) return;
      void get().readOutput(sessionId, processId).finally(() => {
        if (!get().outputsById.get(processId)?.followTail) return;
        followTimers.set(processId, setTimeout(tick, 500));
      });
    };
    tick();
  },

  async stop(sessionId, processId) {
    await backgroundProcessesApi.stop(sessionId, processId);
    cancelFollow(processId);
    await get().loadForSession(sessionId);
  },

  clearSession(sessionId) {
    const list = get().listsBySession.get(sessionId);
    for (const p of list?.processes ?? []) cancelFollow(p.id as string);
    set((state) => {
      const lists = new Map(state.listsBySession);
      lists.delete(sessionId);
      const outputs = new Map(state.outputsById);
      for (const p of list?.processes ?? []) outputs.delete(p.id as string);
      return { listsBySession: lists, outputsById: outputs };
    });
  },
}));
