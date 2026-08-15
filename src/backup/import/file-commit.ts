import fs from 'node:fs';
import path from 'node:path';
import { SessionImportError } from './errors.js';
import { assertPortableImportId, resolvePathInside } from './path-policy.js';

/** 管理 SQLite 提交前创建的正式文件，并在导入失败时统一回滚。 */
export class SessionImportFileCommit {
  readonly sessionRoot: string;
  private readonly createdSharedFiles: string[] = [];
  private committed = false;

  constructor(private readonly activeDataDir: string, readonly sessionId: string) {
    assertPortableImportId(sessionId, 'Session id');
    const sessionsRoot = resolvePathInside(activeDataDir, 'sessions');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    this.sessionRoot = resolvePathInside(sessionsRoot, sessionId);
    if (fs.existsSync(this.sessionRoot)) {
      throw new SessionImportError('destination_conflict', `Session 文件目录已存在: ${sessionId}`, 409);
    }
    fs.mkdirSync(this.sessionRoot);
  }

  copyToSession(source: string, ...relativeSegments: string[]): string {
    const destination = resolvePathInside(this.sessionRoot, ...relativeSegments);
    this.copyExclusive(source, destination);
    return destination;
  }

  commit(): void { this.committed = true; }

  rollback(): void {
    if (this.committed) return;
    for (const filePath of this.createdSharedFiles.reverse()) {
      try { fs.rmSync(filePath, { force: true }); } catch { /* 尽力回滚。 */ }
    }
    try { fs.rmSync(this.sessionRoot, { recursive: true, force: true }); } catch { /* 尽力回滚。 */ }
  }

  private copyExclusive(source: string, destination: string): void {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new SessionImportError('destination_conflict', `导入目标文件已存在: ${path.basename(destination)}`, 409);
      }
      throw error;
    }
  }
}
