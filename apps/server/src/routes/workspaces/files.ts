// 前端 Files 面板的本机文件浏览：列目录与有界文件预览（文本/图片/base64 分流）。
// 本机单人桌面应用，用户即机器所有者，任意路径读取是有意设计。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import * as fsP from 'node:fs/promises';
import * as nodePath from 'node:path';
import { Readable } from 'node:stream';
import { queryValidator } from '../validate.js';

const pathQuery = z.object({
  path: z.string().min(1).max(2000),
});

/** 文件预览体积上限；超出只回尺寸让前端降级。 */
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

const TEXT_EXTS = new Set([
  'md', 'mdx', 'txt', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp',
  'json', 'jsonl', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'css', 'scss', 'sass', 'less',
  'html', 'htm', 'xml', 'svg', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql', 'gql', 'env', 'gitignore',
  'log', 'csv', 'tsv',
]);

const IMAGE_EXTS: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
};

const AUDIO_MIME = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.opus', 'audio/ogg'],
  ['.webm', 'audio/webm'],
]);

interface AudioByteRange {
  readonly start: number;
  readonly end: number;
}

/** 
 * 把 HTTP Range 头解析成要读取的字节区间
 * @returns
 * - undefined 没要求分段, 读整个文件
 * - null 要求了分段, 但这段读不了
 * - {start,end}-> 读这个闭区间
 */
function audioByteRange(header: string | undefined, size: number): AudioByteRange | null | undefined {
  // 三种情况按完整文件回应
  // 没有 Range 头 不以 bytes= 开头
  // 多区间请求, 比如 bytes=0-10,20-30
  if (!header || !/^bytes=/i.test(header) || header.includes(',')) {
    // 多区间标准上应该返回 multipart/byteranges, 但实现复杂 且原生 <audio> 只用单区间 
    // 所以选择不拼 multipart, 直接返回完整文件
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) {
    return null;
  }

  // 后缀区间 bytes=-N
  const length = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]!);
    if (suffix === 0n) {
      return null;
    }
    return { start: Number(suffix >= length ? 0n : length - suffix), end: size - 1 };
  }

  // 普通区间 bytes=A-B 和 bytes=A-
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : length - 1n;
  if (start >= length || end < start) {
    return null;
  }
  return { start: Number(start), end: Number(end >= length ? length - 1n : end) };
}

interface FileEntry {
  name: string;
  /** 正斜杠归一的绝对路径。 */
  path: string;
  type: 'file' | 'dir';
  /** 字节数；目录不带。 */
  size?: number;
}

export const filesRoute = () =>
  new Hono()
    .get('/files/ls', queryValidator(pathQuery), async context => {
      const dirPath = context.req.valid('query').path;
      try {
        const stat = await fsP.stat(dirPath);
        if (!stat.isDirectory()) return context.json({ error: 'not_a_directory' }, 400);

        const raw = await fsP.readdir(dirPath, { withFileTypes: true });
        const entries = await Promise.all(
          raw.map(async (entry): Promise<FileEntry> => {
            let size: number | undefined;
            if (entry.isFile()) {
              try {
                size = (await fsP.stat(nodePath.join(dirPath, entry.name))).size;
              } catch {
                // 单文件 stat 失败只丢尺寸，不拖垮整列。
              }
            }
            return {
              name: entry.name,
              path: nodePath.join(dirPath, entry.name).replace(/\\/g, '/'),
              type: entry.isDirectory() ? 'dir' : 'file',
              size,
            };
          }),
        );
        // 目录在前，组内按名称（大小写不敏感）。
        entries.sort((left, right) => {
          if (left.type !== right.type) return left.type === 'dir' ? -1 : 1;
          return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
        });
        return context.json({ entries });
      } catch (error) {
        return fsError(context, error);
      }
    })
    .get('/files/file', queryValidator(pathQuery), async context => {
      const filePath = context.req.valid('query').path;
      try {
        const stat = await fsP.stat(filePath);
        if (stat.isDirectory()) return context.json({ error: 'is_a_directory' }, 400);
        if (stat.size > MAX_PREVIEW_BYTES) {
          return context.json({ tooLarge: true, size: stat.size, limit: MAX_PREVIEW_BYTES });
        }

        const ext = (filePath.split(/[\\/]/).pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
        const imageMime = IMAGE_EXTS[ext];
        if (imageMime) {
          const buffer = await fsP.readFile(filePath);
          return context.json({
            content: buffer.toString('base64'),
            encoding: 'base64' as const,
            mimeType: imageMime,
            size: stat.size,
          });
        }
        if (TEXT_EXTS.has(ext)) {
          const content = await fsP.readFile(filePath, 'utf8');
          return context.json({ content, encoding: 'text' as const, mimeType: 'text/plain', size: stat.size });
        }
        // 未知扩展名按 utf8 试读（大量配置/日志无扩展名）；替换字符占比高则判二进制。
        try {
          const content = await fsP.readFile(filePath, 'utf8');
          const sample = content.slice(0, 1000);
          const badRatio = (sample.match(/�/g)?.length ?? 0) / Math.max(sample.length, 1);
          if (badRatio > 0.1) throw new Error('likely binary');
          return context.json({ content, encoding: 'text' as const, mimeType: 'text/plain', size: stat.size });
        } catch {
          return context.json({ binary: true, mimeType: 'application/octet-stream', size: stat.size });
        }
      } catch (error) {
        return fsError(context, error);
      }
    })
    .get('/files/audio', queryValidator(pathQuery), async context => {
      const filePath = context.req.valid('query').path;
      if (!nodePath.isAbsolute(filePath)) {
        return context.json({ error: 'absolute_path_required' }, 400);
      }
      const mime = AUDIO_MIME.get(nodePath.extname(filePath).toLowerCase());
      if (!mime) {
        return context.json({ error: 'unsupported_audio_type' }, 415);
      }
      let handle: fsP.FileHandle | undefined;
      try {
        if (!(await fsP.stat(filePath)).isFile()) {
          return context.json({ error: 'not_a_file' }, 400);
        }
        handle = await fsP.open(filePath, 'r');
        const { size } = await handle.stat();
        // 此接口不提供文件版本校验. 收到 If-Range 时读完整文件, 不对可能已替换的文件续读旧区间.
        const range = audioByteRange(context.req.header('if-range') ? undefined : context.req.header('range'), size);
        const headers = new Headers({
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        if (range === null) {
          headers.set('Content-Range', `bytes */${size}`);
          return new Response(null, { status: 416, headers });
        }
        const start = range?.start ?? 0;
        const end = range?.end ?? size - 1;
        headers.set('Content-Length', String(range ? end - start + 1 : size));
        if (range) {
          headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
        }
        if (size === 0) {
          return new Response(null, { headers });
        }
        // 浏览器取消读取时, toWeb 会销毁文件流; 请求断开也通过 signal 关闭同一个文件句柄.
        const stream = handle.createReadStream({ start, end, autoClose: true, signal: context.req.raw.signal });
        // Web 流按块等待浏览器继续读取, 不让默认队列把后面的音频提前全部放进内存.
        const body = Readable.toWeb(stream, { strategy: { highWaterMark: 1 } }) as ReadableStream<Uint8Array>;
        handle = undefined;
        return new Response(body, { status: range ? 206 : 200, headers });
      } catch (error) {
        return fsError(context, error);
      } finally {
        await handle?.close();
      }
    });

function fsError(context: Context, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return context.json({ error: 'path_not_found' }, 404);
  if (code === 'EACCES') return context.json({ error: 'access_denied' }, 403);
  throw error;
}
