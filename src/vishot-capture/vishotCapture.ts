import { captureScreen } from './captureScreen.js';

export interface VishotCaptureDeps {
  readonly readSettings: () => { readonly enabled: boolean; readonly intervalSeconds: number };
  /** 截图前检查 Session、模型能力和电脑控制占用, false 时本次不启动捕获. */
  readonly canStartCapture: (sessionId: string) => boolean;
  /** 截图后及保存后再次检查, 不能把截图期间已经失效的结果送入队列. */
  readonly shouldSubmitCapture: (sessionId: string) => boolean;
  readonly captureImage?: (signal: AbortSignal) => Promise<Buffer>;
  readonly saveImage: (sessionId: string, bytes: Buffer) => Promise<{ readonly path: string }>;
  /** 检查空闲和入队必须同步完成, false 表示图片未采用, 本次不重试. */
  readonly enqueueIfIdle: (sessionId: string, imagePath: string) => boolean;
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
  // 只保存成功入队的比较基准. 被拒绝的图片不能压掉下一次真正可提交的画面.
  private lastSubmittedImage: Buffer | null = null;

  constructor(private readonly deps: VishotCaptureDeps) {}

  setSessionId(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.configure();
  }

  /** 设置变化后由宿主调用. 取消旧自动操作, 启用时重新等待完整间隔. */
  configure(): void {
    this.lastSubmittedImage = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // 取消属于本次配置的结果. A -> B -> A 也不能让第一次 A 的图片进入队列.
    this.captureController?.abort();
    const settings = this.deps.readSettings();
    if (this.lifetime.signal.aborted || !settings.enabled || this.sessionId === null) return;
    this.timer = setInterval(() => this.tick(), settings.intervalSeconds * 1000);
    this.timer.unref();
  }

  /** 工具截图不受自动捕获开关或当前查看的 Session 限制, 同时只提交一个截图请求. */
  async capture(signal: AbortSignal): Promise<Buffer> {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    while (this.capturing !== null) {
      await this.capturing.catch(() => undefined);
      combined.throwIfAborted();
    }
    combined.throwIfAborted();
    const capturing = (this.deps.captureImage ?? captureScreen)(combined);
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
    if (!this.deps.canStartCapture(sessionId)) return;
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
    if (!this.deps.shouldSubmitCapture(sessionId)) return;
    if (await this.isDuplicate(bytes)) return;
    signal.throwIfAborted();
    if (!this.deps.shouldSubmitCapture(sessionId)) return;
    const image = await this.deps.saveImage(sessionId, bytes);
    signal.throwIfAborted();
    if (!this.deps.shouldSubmitCapture(sessionId)) return;
    // 保存期间可能收到用户输入. 队列内部同步检查空闲并入队, 这里不先查再异步提交.
    if (this.deps.enqueueIfIdle(sessionId, image.path)) {
      this.lastSubmittedImage = bytes;
    }
  }

  private async isDuplicate(bytes: Buffer): Promise<boolean> {
    const previous = this.lastSubmittedImage;
    if (!previous) return false;
    if (bytes.equals(previous)) return true;
    // PNG 编码或元数据可以不同. 字节不同再比较解码后的像素, 不使用相似度阈值.
    const { default: sharp } = await import('sharp');
    const [current, last] = await Promise.all([
      sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(previous).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    return current.info.width === last.info.width
      && current.info.height === last.info.height
      && current.data.equals(last.data);
  }
}
