import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { WALLPAPER_IMAGE_EXTENSIONS } from './wallpaperCatalog.js';

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

  // 只在启动装配时执行. 单个文件原地改路径, 不解码或重存图片.
  migrateSettingsGallery(): void {
    const settingsDirectory = path.join(this.root, 'settings');
    if (fs.existsSync(settingsDirectory)) {
      const entries = fs.readdirSync(settingsDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && this.validName(entry.name));
      // 先核对全部目标文件, 不允许覆盖统一目录里已有的同名图片.
      for (const entry of entries) {
        if (fs.existsSync(path.join(this.root, entry.name))) {
          throw new Error(`壁纸迁移存在同名文件: ${entry.name}`);
        }
      }
      for (const entry of entries) {
        fs.renameSync(path.join(settingsDirectory, entry.name), path.join(this.root, entry.name));
      }
      if (fs.readdirSync(settingsDirectory).length === 0) {
        fs.rmdirSync(settingsDirectory);
      }
    }

    // Chat 图库不参与合并. 只删除受管图片, 不递归删除目录里的其他文件.
    const chatDirectory = path.join(this.root, 'chat');
    if (fs.existsSync(chatDirectory)) {
      for (const entry of fs.readdirSync(chatDirectory, { withFileTypes: true })) {
        if (entry.isFile() && this.validName(entry.name)) {
          fs.unlinkSync(path.join(chatDirectory, entry.name));
        }
      }
      if (fs.readdirSync(chatDirectory).length === 0) {
        fs.rmdirSync(chatDirectory);
      }
    }
  }

  async list(): Promise<WallpaperImageSummary[]> {
    const dir = this.root;
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

  async import(originalName: string, bytes: Buffer): Promise<WallpaperImageSummary | null> {
    const ext = path.extname(originalName).toLowerCase();
    const expectedFormat = formatFor(ext);
    if (!expectedFormat || originalName.length > 120) return null;
    try {
      const metadata = await sharp(bytes).metadata();
      if (metadata.format !== expectedFormat) return null;
    } catch {
      return null;
    }
    const dir = this.root;
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

  async get(name: string): Promise<WallpaperImageFile | null> {
    if (!this.validName(name)) return null;
    const filePath = path.join(this.root, name);
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

  async thumbnail(name: string): Promise<Buffer | null> {
    const file = await this.get(name);
    if (!file) return null;
    return sharp(file.path)
      .rotate()
      .resize(320, 200, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 76 })
      .toBuffer();
  }

  async rename(name: string, requestedBase: string): Promise<WallpaperImageSummary | null> {
    const file = await this.get(name);
    if (!file) return null;
    const base = cleanBase(requestedBase);
    const ext = path.extname(name);
    if (base === path.basename(name, ext)) {
      return { name: file.name, size: file.size, modifiedAt: file.modifiedAt };
    }
    const dir = this.root;
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

  async remove(name: string): Promise<boolean> {
    const file = await this.get(name);
    if (!file) return false;
    await fs.promises.unlink(file.path);
    return true;
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
