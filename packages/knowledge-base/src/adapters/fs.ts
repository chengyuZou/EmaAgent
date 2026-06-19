import { readFile, stat } from 'node:fs/promises';

export interface FsAdapter {
  readBytes(path: string): Promise<Uint8Array>;
  readText(path:  string): Promise<string>;
  stat(path: string): Promise<{ size: number; mtime: Date }>;
}

export class NodeFsAdapter implements FsAdapter {
  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  }

  async readText(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async stat(path: string): Promise<{ size: number; mtime: Date }> {
    const s = await stat(path);
    return { size: s.size, mtime: s.mtime };
  }
}
