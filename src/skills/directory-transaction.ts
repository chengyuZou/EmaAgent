// 这里用 staging, backup 和 journal 让 Skill 目录替换可以回滚并在启动时恢复.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { SkillPathError } from './errors.js';

type TransactionPhase = 'prepared' | 'activated' | 'indexed';

interface SkillDirectoryJournal {
  version: 1;
  stageName: string;
  finalName: string;
  previousName: string | null;
  backupName: string | null;
}

const JOURNAL_PREFIX = '.ema-skill-transaction-';
const STAGE_PREFIX = '.ema-skill-stage-';
const BACKUP_PREFIX = '.ema-skill-backup-';

export class SkillDirectoryTransaction {
  readonly stagePath: string;
  private readonly journalPath: string;
  private readonly activatedMarkerPath: string;
  private readonly indexedMarkerPath: string;
  private phase: TransactionPhase = 'prepared';
  private previousPath: string | null = null;
  private backupPath: string | null = null;
  private finalPath: string | null = null;

  private constructor(
    private readonly rootPath: string,
    transactionId: string,
    slug: string,
  ) {
    this.stagePath = join(rootPath, `${STAGE_PREFIX}${slug}-${transactionId}`);
    this.journalPath = join(rootPath, `${JOURNAL_PREFIX}${transactionId}.json`);
    this.activatedMarkerPath = `${this.journalPath}.activated`;
    this.indexedMarkerPath = `${this.journalPath}.indexed`;
  }

  static async create(rootPath: string, slug: string): Promise<SkillDirectoryTransaction> {
    const transaction = new SkillDirectoryTransaction(rootPath, randomUUID(), slug);
    await mkdir(transaction.stagePath, { recursive: false });
    return transaction;
  }

  async prepare(previousPath: string | null, finalPath: string): Promise<void> {
    this.assertDirectChild(finalPath);
    if (previousPath) this.assertDirectChild(previousPath);
    this.previousPath = previousPath;
    this.finalPath = finalPath;
    this.backupPath = previousPath
      ? join(this.rootPath, `${BACKUP_PREFIX}${basename(previousPath)}-${randomUUID()}`)
      : null;
    await this.writeJournal();
  }

  async activate(): Promise<void> {
    if (!this.finalPath) throw new Error('Skill directory transaction is not prepared');
    if (this.previousPath && this.backupPath) {
      await rename(this.previousPath, this.backupPath);
    }
    await rename(this.stagePath, this.finalPath);
    this.phase = 'activated';
    await this.writePhaseMarker(this.activatedMarkerPath);
  }

  async markIndexed(): Promise<void> {
    this.phase = 'indexed';
    await this.writePhaseMarker(this.indexedMarkerPath);
  }

  async commit(): Promise<void> {
    let cleanupComplete = true;
    if (this.backupPath) {
      await rm(this.backupPath, { recursive: true, force: true }).catch(() => {
        cleanupComplete = false;
      });
    }
    await rm(this.stagePath, { recursive: true, force: true }).catch(() => {
      cleanupComplete = false;
    });
    // 清理失败时保留 indexed journal, 下次启动继续清理, 不能留下无主 backup.
    if (cleanupComplete) {
      // journal 先删除. 后续 marker 即使残留也不会再触发恢复.
      let journalRemoved = true;
      await rm(this.journalPath, { force: true }).catch(() => {
        journalRemoved = false;
      });
      if (journalRemoved) {
        await rm(this.activatedMarkerPath, { force: true }).catch(() => undefined);
        await rm(this.indexedMarkerPath, { force: true }).catch(() => undefined);
      }
    }
  }

  async rollback(): Promise<void> {
    if (this.phase !== 'prepared' && this.finalPath) {
      await rm(this.finalPath, { recursive: true, force: true });
    }
    if (this.previousPath && this.backupPath) {
      await rename(this.backupPath, this.previousPath).catch(async error => {
        if (await pathExists(this.backupPath!)) throw error;
      });
    }
    await rm(this.stagePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(this.activatedMarkerPath, { force: true }).catch(() => undefined);
    await rm(this.indexedMarkerPath, { force: true }).catch(() => undefined);
    await rm(this.journalPath, { force: true }).catch(() => undefined);
  }

  private assertDirectChild(targetPath: string): void {
    const resolvedRoot = resolve(this.rootPath);
    const resolvedTarget = resolve(targetPath);
    if (dirname(resolvedTarget) !== resolvedRoot || !resolvedTarget.startsWith(resolvedRoot + sep)) {
      throw new SkillPathError(`Skill transaction target escapes writable root: ${targetPath}`);
    }
  }

  private async writeJournal(): Promise<void> {
    if (!this.finalPath) throw new Error('Skill directory transaction is not prepared');
    const journal: SkillDirectoryJournal = {
      version: 1,
      stageName: basename(this.stagePath),
      finalName: basename(this.finalPath),
      previousName: this.previousPath ? basename(this.previousPath) : null,
      backupName: this.backupPath ? basename(this.backupPath) : null,
    };
    const handle = await open(this.journalPath, 'wx');
    try {
      await handle.writeFile(JSON.stringify(journal), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writePhaseMarker(markerPath: string): Promise<void> {
    const handle = await open(markerPath, 'wx');
    try {
      await handle.writeFile(this.phase, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function recoverSkillDirectoryTransactions(rootPath: string): Promise<string[]> {
  const errors: string[] = [];
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return errors;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(JOURNAL_PREFIX) || !entry.name.endsWith('.json')) continue;
    const journalPath = join(rootPath, entry.name);
    try {
      const journal = parseJournal(await readFile(journalPath, 'utf8'));
      const stagePath = childPath(rootPath, journal.stageName);
      const finalPath = childPath(rootPath, journal.finalName);
      const previousPath = journal.previousName ? childPath(rootPath, journal.previousName) : null;
      const backupPath = journal.backupName ? childPath(rootPath, journal.backupName) : null;
      const activatedMarkerPath = `${journalPath}.activated`;
      const indexedMarkerPath = `${journalPath}.indexed`;
      const phase: TransactionPhase = await pathExists(indexedMarkerPath)
        ? 'indexed'
        : await pathExists(activatedMarkerPath) ? 'activated' : 'prepared';

      if (phase === 'indexed') {
        if (backupPath) await rm(backupPath, { recursive: true, force: true });
        await rm(stagePath, { recursive: true, force: true });
      } else {
        // prepared journal 但 staging 已消失, 表示进程可能在 rename 后且更新 phase 前崩溃.
        const stageExists = await pathExists(stagePath);
        const backupExists = backupPath ? await pathExists(backupPath) : false;
        if (previousPath && backupPath) {
          // backup 仍在才说明回滚未完成. backup 已消失且 previous 已恢复时保持旧目录.
          if (backupExists) {
            if (phase === 'activated' || !stageExists) {
              await rm(finalPath, { recursive: true, force: true });
            }
            await rename(backupPath, previousPath);
          }
        } else if (phase === 'activated' || !stageExists) {
          // 首次安装没有 previous, 回滚只需移除尚未建索引的新目录.
          await rm(finalPath, { recursive: true, force: true });
        }
        await rm(stagePath, { recursive: true, force: true });
      }
      await rm(journalPath, { force: true });
      await rm(activatedMarkerPath, { force: true });
      await rm(indexedMarkerPath, { force: true });
    } catch (error) {
      errors.push(`${journalPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

function parseJournal(raw: string): SkillDirectoryJournal {
  const value = JSON.parse(raw) as Partial<SkillDirectoryJournal>;
  if (value.version !== 1
    || typeof value.stageName !== 'string'
    || typeof value.finalName !== 'string'
    || (value.previousName !== null && typeof value.previousName !== 'string')
    || (value.backupName !== null && typeof value.backupName !== 'string')) {
    throw new Error('Invalid Skill directory transaction journal');
  }
  return value as SkillDirectoryJournal;
}

function childPath(rootPath: string, name: string): string {
  if (!name || basename(name) !== name || name === '.' || name === '..') {
    throw new SkillPathError(`Invalid Skill transaction path: ${name}`);
  }
  return join(rootPath, name);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
