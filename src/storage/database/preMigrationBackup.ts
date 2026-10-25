import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const COPIES_TO_KEEP = 3;

function backupFileName(
  kind: 'profile' | 'data',
  fromVersion: number,
  toVersion: number,
  timestamp: string,
  id: string,
): string {
  return `${kind}.v${fromVersion}-to-v${toVersion}.${timestamp}.${id}.db`;
}

function readBackupName(filename: string, kind: 'profile' | 'data'): {
  timestamp: string;
  temporary: boolean;
} | undefined {
  const completeName = filename.replace(/\.tmp(?:-wal|-shm)?$/u, '');
  const [fileKind, versionRange, timestamp, id] = completeName.split('.');
  if (fileKind !== kind || !versionRange || !timestamp || !id) return undefined;
  const versions = /^v(\d+)-to-v(\d+)$/u.exec(versionRange);
  if (!versions || !/^\d{8}T\d{9}Z$/u.test(timestamp) || !/^[a-f0-9-]{36}$/u.test(id)) {
    return undefined;
  }
  // 目录中可能有手工副本或其他文件. 以生成正式副本的同一函数核对完整文件名后才允许清理.
  const expectedName = backupFileName(kind, Number(versions[1]), Number(versions[2]), timestamp, id);
  if (completeName !== expectedName) return undefined;
  return { timestamp, temporary: completeName !== filename };
}

// TODO: 提供副本恢复入口. 当前需人工判断恢复范围, 尚未处理多库协调恢复和保留备份后的新增数据.
export async function createPreMigrationBackup(
  db: Database.Database,
  kind: 'profile' | 'data',
  directory: string,
  fromVersion: number,
  toVersion: number,
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[-:.]/gu, '');
  const filename = backupFileName(kind, fromVersion, toVersion, timestamp, randomUUID());
  const destination = path.join(directory, filename);
  const temporary = `${destination}.tmp`;
  let ownsTemporary = false;

  try {
    await fs.mkdir(directory, { recursive: true });
    const file = await fs.open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    await file.close();
    // 通过 SQLite 复制已提交的 WAL 内容和原 rowid, 不重建表或重排全文检索的行号.
    await db.backup(temporary);
    const copy = new Database(temporary, { fileMustExist: true });
    try {
      // 副本独立保存为单文件. 只切换副本的日志模式, 避免打开它时创建 WAL/SHM 辅助文件.
      copy.pragma('journal_mode = DELETE');
    } finally {
      copy.close();
    }
    await fs.rename(temporary, destination);
  } catch (error) {
    if (ownsTemporary) {
      for (const file of [temporary, `${temporary}-wal`, `${temporary}-shm`]) {
        await fs.rm(file, { force: true }).catch((cleanupError: unknown) => {
          console.warn(`[${kind}] 无法清理未完成的迁移前副本 ${file}`, cleanupError);
        });
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[${kind}] 迁移前副本生成失败: ${destination} (${reason})`, { cause: error });
  }
}

/** 只能在本次全部 SQL 提交成功后调用, 避免失败重试淘汰升级前的可用副本. */
export async function prunePreMigrationBackups(directory: string, kind: 'profile' | 'data'): Promise<void> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const copies: Array<{ name: string; timestamp: string }> = [];
    const temporaryFiles: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const backup = readBackupName(entry.name, kind);
      if (!backup) continue;
      if (backup.temporary) {
        temporaryFiles.push(entry.name);
      } else {
        copies.push({ name: entry.name, timestamp: backup.timestamp });
      }
    }
    copies.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.name.localeCompare(a.name));
    const expired = copies.slice(COPIES_TO_KEEP).map(copy => copy.name);
    for (const filename of [...expired, ...temporaryFiles]) {
      await fs.unlink(path.join(directory, filename));
    }
  } catch (error) {
    // SQL 已经提交, 清理旧副本失败不能使已完成的升级再次被报告成迁移失败.
    console.warn(`[${kind}] 迁移已完成, 但无法清理过期副本 ${directory}`, error);
  }
}
