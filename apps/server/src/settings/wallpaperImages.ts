// 管理 Chat 与 Settings 的壁纸文件, 列表只返回文件摘要并按需生成缩略图.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  WALLPAPER_IMAGE_EXTENSIONS,
  type WallpaperWindowTarget,
} from './wallpaperCatalog.js';

export interface WallpaperImageSummary {
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: number;
}

export interface WallpaperImageFile extends WallpaperImageSummary {
  readonly path: string;
  readonly mime: string;
}

export class WallpaperImages {
  constructor(private readonly root: string) {}

  async list(target: WallpaperWindowTarget): Promise<WallpaperImageSummary[]> {
    const dir = this.dir(target);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const items: WallpaperImageSummary[] = [];
    for (const name of names.sort()) {
      if (!this.validName(name)) continue;
      const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
      if (!stat?.isFile()) continue;
      items.push({ name, size: stat.size, modifiedAt: Math.round(stat.mtimeMs) });
    }
    return items;
  }

  async import(target: WallpaperWindowTarget, originalName: string, bytes: Buffer): Promise<WallpaperImageSummary | null> {
    const ext = path.extname(originalName).toLowerCase();
    const expectedFormat = formatFor(ext);
    if (!expectedFormat || originalName.length > 120) return null;
    try {
      const metadata = await sharp(bytes).metadata();
      if (metadata.format !== expectedFormat) return null;
    } catch {
      return null;
    }
    const dir = this.dir(target);
    await fs.promises.mkdir(dir, { recursive: true });
    const base = cleanBase(path.basename(originalName, path.extname(originalName)));
    for (let serial = 0; ; serial += 1) {
      const name = candidateName(base, ext, serial);
      try {
        await fs.promises.writeFile(path.join(dir, name), bytes, { flag: 'wx' });
        const stat = await fs.promises.stat(path.join(dir, name));
        return { name, size: stat.size, modifiedAt: Math.round(stat.mtimeMs) };
      } catch (error) {
        if (isAlreadyExists(error)) continue;
        throw error;
      }
    }
  }

  async get(target: WallpaperWindowTarget, name: string): Promise<WallpaperImageFile | null> {
    if (!this.validName(name)) return null;
    const filePath = path.join(this.dir(target), name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!stat.isFile()) return null;
    return {
      name,
      size: stat.size,
      modifiedAt: Math.round(stat.mtimeMs),
      path: filePath,
      mime: mimeFor(path.extname(name).toLowerCase()),
    };
  }

  async thumbnail(target: WallpaperWindowTarget, name: string): Promise<Buffer | null> {
    const file = await this.get(target, name);
    if (!file) return null;
    return sharp(file.path)
      .rotate()
      .resize(320, 200, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 76 })
      .toBuffer();
  }

  async rename(target: WallpaperWindowTarget, name: string, requestedBase: string): Promise<WallpaperImageSummary | null> {
    const file = await this.get(target, name);
    if (!file) return null;
    const base = cleanBase(requestedBase);
    const ext = path.extname(name);
    if (base === path.basename(name, ext)) {
      return { name: file.name, size: file.size, modifiedAt: file.modifiedAt };
    }
    const dir = this.dir(target);
    for (let serial = 0; ; serial += 1) {
      const nextName = candidateName(base, ext, serial);
      const destination = path.join(dir, nextName);
      try {
        await fs.promises.copyFile(file.path, destination, fs.constants.COPYFILE_EXCL);
        await fs.promises.unlink(file.path);
        const stat = await fs.promises.stat(destination);
        return { name: nextName, size: stat.size, modifiedAt: Math.round(stat.mtimeMs) };
      } catch (error) {
        if (isAlreadyExists(error)) continue;
        throw error;
      }
    }
  }

  async remove(target: WallpaperWindowTarget, name: string): Promise<boolean> {
    const file = await this.get(target, name);
    if (!file) return false;
    await fs.promises.unlink(file.path);
    return true;
  }

  private dir(target: WallpaperWindowTarget): string {
    return path.join(this.root, target);
  }

  private validName(name: string): boolean {
    return name !== '.'
      && name !== '..'
      && !/[/\\]/.test(name)
      && (WALLPAPER_IMAGE_EXTENSIONS as readonly string[]).includes(path.extname(name).toLowerCase());
  }
}

function cleanBase(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '') || 'wallpaper';
}

function candidateName(base: string, ext: string, serial: number): string {
  const suffix = serial === 0 ? '' : `(${serial})`;
  return `${base.slice(0, 120 - ext.length - suffix.length)}${suffix}${ext}`;
}

function mimeFor(ext: string): string {
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

function formatFor(ext: string): string | null {
  switch (ext) {
    case '.png': return 'png';
    case '.jpg':
    case '.jpeg': return 'jpeg';
    case '.webp': return 'webp';
    default: return null;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}
