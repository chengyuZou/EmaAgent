import { captureScreen } from './captureScreen.js';

export interface VishotCaptureDeps {
  readonly readSettings: () => { readonly enabled: boolean; readonly intervalSeconds: number };
  readonly isIdle: (sessionId: string) => boolean;
  readonly canReadImages: (sessionId: string) => boolean;
  readonly saveImage: (sessionId: string, bytes: Buffer) => Promise<{ readonly path: string }>;
  readonly enqueueIfIdleForVishotCapture: (sessionId: string, imagePath: string) => boolean;
  readonly onError: (error: unknown) => void;
}

export class VishotCapture {
  private sessionId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private captureController: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private pendingSessionId: string | null = null;
  private capturing: Promise<Buffer> | null = null;
  private readonly lifetime = new AbortController();

  constructor(private readonly deps: VishotCaptureDeps) {}

  setSessionId(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.configure();
  }

  configure(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // 取消属于本次配置的结果. A -> B -> A 也不能让第一次 A 的图片进入队列.
    this.captureController?.abort();
    const settings = this.deps.readSettings();
    if (this.lifetime.signal.aborted || !settings.enabled || this.sessionId === null) return;
    this.timer = setInterval(() => this.tick(), settings.intervalSeconds * 1000);
    this.timer.unref();
  }

  /** 工具截图不受自动捕获开关或当前查看的 Session 限制, 但共用单个截图进程. */
  async capture(signal: AbortSignal): Promise<Buffer> {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    while (this.capturing !== null) {
      await this.capturing.catch(() => undefined);
      combined.throwIfAborted();
    }
    combined.throwIfAborted();
    const capturing = captureScreen(combined);
    this.capturing = capturing;
    try {
      return await capturing;
    } finally {
      this.capturing = null;
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    this.configure();
    await this.pending;
    await this.capturing?.catch(() => undefined);
  }

  async cancelSession(sessionId: string): Promise<void> {
    if (this.sessionId === sessionId) this.setSessionId(null);
    if (this.pendingSessionId !== sessionId) return;
    this.captureController?.abort();
    // Session 删除必须等可能已开始的图片保存结束, 不能让它在目录删除后又写回来.
    await this.pending;
  }

  private tick(): void {
    if (this.pending !== null || this.capturing !== null || this.sessionId === null) return;
    const sessionId = this.sessionId;
    if (!this.deps.isIdle(sessionId) || !this.deps.canReadImages(sessionId)) return;
    const controller = new AbortController();
    this.captureController = controller;
    this.pendingSessionId = sessionId;
    this.pending = this.captureAndSubmit(sessionId, controller.signal)
      .catch(error => {
        if (!controller.signal.aborted && !this.lifetime.signal.aborted) this.deps.onError(error);
      })
      .finally(() => {
        // abort 只是请求取消, 必须等截图和保存真正结束后才允许下一次捕获.
        this.pending = null;
        this.pendingSessionId = null;
        this.captureController = null;
      });
  }

  private async captureAndSubmit(sessionId: string, signal: AbortSignal): Promise<void> {
    const bytes = await this.capture(signal);
    signal.throwIfAborted();
    if (!this.deps.isIdle(sessionId) || !this.deps.canReadImages(sessionId)) return;
    const image = await this.deps.saveImage(sessionId, bytes);
    signal.throwIfAborted();
    if (!this.deps.canReadImages(sessionId)) return;
    // 保存期间可能收到用户输入. 队列内部同步检查空闲并入队, 这里不先查再异步提交.
    this.deps.enqueueIfIdleForVishotCapture(sessionId, image.path);
  }
}
