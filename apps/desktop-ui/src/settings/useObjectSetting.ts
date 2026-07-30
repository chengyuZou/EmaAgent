// 对象设置的读取与防抖即存:补丁合并 → 本地先行 → 停手 700ms 提交;失败回滚并提示,不假装生效。
// 状态机在 SettingAutosaver(纯 TS,可单测),Hook 只是它的 React 壳。
import { useCallback, useEffect, useRef, useState } from 'react';
import { settingsApi } from '../api/settings.js';
import { showToast } from '../lib/toast.js';

export type SettingSaveState = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DEBOUNCE_MS = 700;
const SAVED_MARK_MS = 2_000;

export interface AutosaverCallbacks<T> {
  /** 持久化成功后的权威值(也用于初始装载与失败回滚)。 */
  onCommitted(value: T): void;
  onSaveState(state: SettingSaveState): void;
  onLoadError(): void;
  onSaveError(error: unknown): void;
}

export class SettingAutosaver<T extends object> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private savedMarkTimer: ReturnType<typeof setTimeout> | null = null;
  /** 待提交的最新合并值;提交期间累积的补丁按 tail 链续传,不乱序。 */
  private pending: T | null = null;
  private inFlight = false;
  private disposed = false;

  constructor(
    private readonly key: string,
    private readonly callbacks: AutosaverCallbacks<T>,
  ) {}

  async load(): Promise<void> {
    try {
      const wire = await settingsApi.getValue<T>(this.key);
      if (this.disposed) return;
      this.callbacks.onCommitted(wire.value);
    } catch {
      if (!this.disposed) this.callbacks.onLoadError();
    }
  }

  /** 提交一个合并后的完整值;700ms 防抖,连续改动只留最新。 */
  schedule(next: T): void {
    if (this.disposed) return;
    this.pending = next;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  private flush(): void {
    if (this.inFlight || this.disposed) return;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.inFlight = true;
    this.callbacks.onSaveState('saving');
    settingsApi.putValue<T>(this.key, pending)
      .then((wire) => {
        if (this.disposed) return;
        this.callbacks.onCommitted(wire.value);
        if (this.pending === null) {
          this.callbacks.onSaveState('saved');
          if (this.savedMarkTimer) clearTimeout(this.savedMarkTimer);
          this.savedMarkTimer = setTimeout(
            () => this.callbacks.onSaveState('idle'),
            SAVED_MARK_MS,
          );
        }
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.pending = null;
        this.callbacks.onSaveState('error');
        this.callbacks.onSaveError(error);
      })
      .finally(() => {
        this.inFlight = false;
        this.flush();
      });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.savedMarkTimer) clearTimeout(this.savedMarkTimer);
  }
}

export interface ObjectSettingController<T> {
  readonly value: T | null;
  readonly saveState: SettingSaveState;
  update(patch: Partial<T>): void;
  reload(): void;
}

export function useObjectSetting<T extends object>(
  key: string,
): ObjectSettingController<T> {
  const [value, setValue] = useState<T | null>(null);
  const [saveState, setSaveState] = useState<SettingSaveState>('idle');
  /** 最近一次持久化成功值,失败回滚用。 */
  const committedRef = useRef<T | null>(null);
  const saverRef = useRef<SettingAutosaver<T> | null>(null);

  if (saverRef.current === null) {
    saverRef.current = new SettingAutosaver<T>(key, {
      onCommitted: (committed) => {
        committedRef.current = committed;
        setValue(committed);
      },
      onSaveState: setSaveState,
      onLoadError: () => showToast('读取设置失败', { variant: 'danger' }),
      onSaveError: (error) => {
        if (committedRef.current) setValue(committedRef.current);
        showToast(
          error instanceof Error ? `保存失败:${error.message}` : '保存失败,已回滚',
          { variant: 'danger' },
        );
      },
    });
  }

  const reload = useCallback((): void => {
    void saverRef.current?.load();
  }, []);

  useEffect(() => {
    const saver = saverRef.current;
    void saver?.load();
    return () => saver?.dispose();
  }, [key]);

  const update = useCallback((patch: Partial<T>): void => {
    // 合并只发生在 setValue 回调内,提交值与显示值同源,不看闭包旧值。
    setValue((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      saverRef.current?.schedule(next);
      return next;
    });
  }, []);

  return { value, saveState, update, reload };
}
