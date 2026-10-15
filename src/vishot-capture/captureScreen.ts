import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// ffmpeg-static 的 CommonJS 导出是路径, 其类型声明没有按 NodeNext 描述这个形状.
const ffmpegPath: string | null = createRequire(import.meta.url)('ffmpeg-static');

/** 单次捕获输出 PNG. macOS 的屏幕录制授权由系统处理, 不申请摄像头或麦克风. */
export async function captureScreen(signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (!ffmpegPath) throw new Error('当前平台没有随包 FFmpeg.');
  const input = await screenInput(signal);
  const result = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...input,
    '-frames:v', '1', '-an', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1',
  ], signal);
  if (result.code !== 0 || result.stdout.length === 0) {
    throw new Error(`屏幕捕获失败. 请检查系统屏幕录制权限及 FFmpeg 采集设备: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function screenInput(signal: AbortSignal): Promise<string[]> {
  switch (process.platform) {
    case 'win32':
      return ['-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0', '-i', 'desktop'];
    case 'darwin': {
      // AVFoundation 把摄像头和屏幕放在同一目录, 不能把设备 0 当作显示器.
      const devices = await runFfmpeg([
        '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '',
      ], signal);
      const screen = devices.stderr.match(/\[(\d+)\]\s+Capture screen\b/);
      if (!screen) throw new Error(`没有找到可捕获的显示器. 请检查屏幕录制权限: ${devices.stderr.trim()}`);
      return ['-f', 'avfoundation', '-framerate', '30', '-capture_cursor', '0', '-i', `${screen[1]}:none`];
    }
    case 'linux':
      if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
        throw new Error('当前测试版只支持 Linux/X11 截图, 暂不支持 Wayland.');
      }
      if (!process.env.DISPLAY) throw new Error('没有可用的 X11 DISPLAY, 无法捕获屏幕.');
      return ['-f', 'x11grab', '-framerate', '30', '-draw_mouse', '0', '-i', process.env.DISPLAY];
    default:
      throw new Error(`不支持当前平台的屏幕捕获: ${process.platform}`);
  }
}

function runFfmpeg(args: readonly string[], signal: AbortSignal): Promise<{
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath!, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    let failure: Error | undefined;
    const abort = () => {
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(() => {
      failure = new Error('屏幕捕获超时, 请检查系统屏幕录制权限.');
      child.kill('SIGKILL');
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });
    child.on('error', error => { failure = error; });
    // 等 close 再返回, 防止调用方误以为进程已退出而启动第二个截图进程.
    child.on('close', code => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(chunks), stderr });
    });
  });
}
