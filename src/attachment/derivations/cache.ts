// 用内存 LRU 和本地内容寻址文件复用已付费的图片 Vision 描述。
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  AttachmentDerivationsRepo,
  AttachmentVisionDerivationIdentity,
} from '@ema-agent/storage';
import type {
  CachedVisionDescription,
  CachedVisionDescriptionRequest,
  NormalizedAttachmentImage,
} from '../types.js';
import { normalizeAttachmentImage } from './imageNormalization.js';

const DEFAULT_MEMORY_ENTRIES = 128;
const DEFAULT_MEMORY_BYTES = 4 * 1024 * 1024;

interface MemoryEntry {
  text: string;
  bytes: number;
}

export interface AttachmentDerivationCacheOptions {
  activeDataDir: string;
  repo: AttachmentDerivationsRepo;
  maxMemoryEntries?: number;
  maxMemoryBytes?: number;
}

export type VisionDescriptionProducer = (
  image: NormalizedAttachmentImage,
) => Promise<string>;

export class AttachmentDerivationCache {
  private readonly root: string;
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly inFlight = new Map<string, Promise<CachedVisionDescription>>();
  private memoryBytes = 0;

  constructor(private readonly options: AttachmentDerivationCacheOptions) {
    this.root = path.join(options.activeDataDir, 'attachments', 'vision-cache');
  }

  async getOrCreate(
    request: CachedVisionDescriptionRequest,
    produce: VisionDescriptionProducer,
  ): Promise<CachedVisionDescription> {
    const image = await normalizeAttachmentImage(request.source, request.signal);
    const identity = createIdentity(request, image);
    const key = identityKey(identity);

    const memoryHit = this.takeMemory(key);
    if (memoryHit) {
      return { text: memoryHit.text, image, cache: 'memory' };
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const operation = this.loadOrCreate(key, identity, request, image, produce);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  clearMemory(): void {
    this.memory.clear();
    this.memoryBytes = 0;
  }

  private async loadOrCreate(
    key: string,
    identity: AttachmentVisionDerivationIdentity,
    request: CachedVisionDescriptionRequest,
    image: NormalizedAttachmentImage,
    produce: VisionDescriptionProducer,
  ): Promise<CachedVisionDescription> {
    request.signal?.throwIfAborted();
    const persisted = this.options.repo.find(identity);
    if (persisted) {
      const outputPath = resolveRelativePath(this.options.activeDataDir, persisted.relative_path);
      try {
        const text = await readFile(outputPath, 'utf8');
        const actualBytes = Buffer.byteLength(text, 'utf8');
        if (actualBytes !== persisted.byte_size) {
          await unlink(outputPath).catch(() => {});
          this.options.repo.deleteMissingDerivation(persisted.id);
        } else {
          this.options.repo.touch(persisted.id, persisted.content_sha256, Date.now());
          await writeFileOnce(imagePathFor(this.root, image), image.bytes);
          this.putMemory(key, { text, bytes: actualBytes });
          return { text, image, cache: 'disk' };
        }
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        this.options.repo.deleteMissingDerivation(persisted.id);
      }
    }

    const text = (await produce(image)).trim();
    request.signal?.throwIfAborted();
    if (!text) throw new Error('Vision 没有返回可缓存的图片描述');

    const now = Date.now();
    const objectDir = objectDirFor(this.root, image);
    const imagePath = path.join(objectDir, 'image.webp');
    const derivationId = randomUUID();
    const derivationPath = path.join(objectDir, 'derivations', `${key}.txt`);

    await writeFileOnce(imagePath, image.bytes);
    await writeFileAtomic(derivationPath, text);

    this.options.repo.save(
      {
        contentSha256: image.contentSha256,
        relativePath: relativePath(this.options.activeDataDir, imagePath),
        mime: image.mimeType,
        byteSize: image.bytes.byteLength,
        width: image.width,
        height: image.height,
        now,
      },
      {
        id: derivationId,
        ...identity,
        relativePath: relativePath(this.options.activeDataDir, derivationPath),
        byteSize: Buffer.byteLength(text, 'utf8'),
        now,
      },
    );

    this.putMemory(key, {
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
    });
    return { text, image, cache: 'miss' };
  }

  private takeMemory(key: string): MemoryEntry | undefined {
    const entry = this.memory.get(key);
    if (!entry) return undefined;
    this.memory.delete(key);
    this.memory.set(key, entry);
    return entry;
  }

  private putMemory(key: string, entry: MemoryEntry): void {
    const previous = this.memory.get(key);
    if (previous) {
      this.memoryBytes -= previous.bytes;
      this.memory.delete(key);
    }
    this.memory.set(key, entry);
    this.memoryBytes += entry.bytes;

    const maxEntries = this.options.maxMemoryEntries ?? DEFAULT_MEMORY_ENTRIES;
    const maxBytes = this.options.maxMemoryBytes ?? DEFAULT_MEMORY_BYTES;
    while (this.memory.size > maxEntries || this.memoryBytes > maxBytes) {
      const oldestKey = this.memory.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.memory.get(oldestKey);
      this.memory.delete(oldestKey);
      if (oldest) this.memoryBytes -= oldest.bytes;
    }
  }
}

function objectDirFor(root: string, image: NormalizedAttachmentImage): string {
  return path.join(root, image.contentSha256.slice(0, 2), image.contentSha256);
}

function imagePathFor(root: string, image: NormalizedAttachmentImage): string {
  return path.join(objectDirFor(root, image), 'image.webp');
}

function createIdentity(
  request: CachedVisionDescriptionRequest,
  image: NormalizedAttachmentImage,
): AttachmentVisionDerivationIdentity {
  return {
    contentSha256: image.contentSha256,
    task: request.task,
    providerConfigId: request.providerConfigId,
    modelId: request.modelId,
    promptSha256: createHash('sha256')
      .update(request.promptRevision, 'utf8')
      .digest('hex'),
    transformVersion: image.transformVersion,
    language: request.language ?? '',
  };
}

function identityKey(identity: AttachmentVisionDerivationIdentity): string {
  return createHash('sha256')
    .update([
      identity.contentSha256,
      identity.task,
      identity.providerConfigId,
      identity.modelId,
      identity.promptSha256,
      identity.transformVersion,
      identity.language,
    ].join('\0'))
    .digest('hex');
}

async function writeFileOnce(filePath: string, data: Uint8Array): Promise<void> {
  try {
    const existing = await stat(filePath);
    if (existing.isFile() && existing.size === data.byteLength) return;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await writeFileAtomic(filePath, data);
}

async function writeFileAtomic(filePath: string, data: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, data, { flag: 'wx' });
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      // Windows 不允许 rename 覆盖既有文件。内容寻址目标若由并发请求先写入，
      // 保留先完成者即可；其他错误继续上抛。
      if (!await sameSize(filePath, data)) throw error;
      await unlink(tempPath);
    }
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function sameSize(filePath: string, data: Uint8Array | string): Promise<boolean> {
  try {
    const existing = await stat(filePath);
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
    return existing.isFile() && existing.size === bytes;
  } catch {
    return false;
  }
}

function relativePath(activeDataDir: string, filePath: string): string {
  const relative = path.relative(path.resolve(activeDataDir), path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('附件缓存路径越出 activeDataDir');
  }
  return relative;
}

function resolveRelativePath(activeDataDir: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error('附件缓存索引不得保存绝对路径');
  const root = path.resolve(activeDataDir);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('附件缓存索引路径越出 activeDataDir');
  }
  return resolved;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && ((error as NodeJS.ErrnoException).code === 'ENOENT'
      || (error as NodeJS.ErrnoException).code === 'ENOTDIR');
}
