import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_RESOURCE_KINDS, dataResourceDir, sessionResourceDir, turnResourceDir } from '@ema-agent/storage/dataPaths';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');


/** 默认 ~/.ema-agent; EMA_PROFILE_DIR 可以覆盖整个 Profile 的位置. 读取时会创建目录. */
export function profileDir(): string {
  const dir = process.env['EMA_PROFILE_DIR'] ?? path.join(os.homedir(), '.ema-agent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function profileDbPath(): string {
  return path.join(profileDir(), 'profile.db');
}

export function preMigrationDir(): string {
  return path.join(profileDir(), 'pre-migration');
}

export function modelsDevCatalogPath(): string {
  return path.join(profileDir(), 'profile', 'models-dev.json');
}

export function narrativeDbPath(): string {
  const directory = path.join(profileDir(), 'narrative');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, 'narrative.db');
}

/** 返回 SQLite 主文件及其 WAL/SHM 辅助文件. */
export function sqliteFileSet(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

export function lockfilePath(): string {
  return path.join(profileDir(), 'lockfile.json');
}

/** 会话数据库和文件放在当前 Profile 的 data 子目录. */
export function dataDirPath(): string {
  return path.join(profileDir(), 'data');
}


/** 所有角色的唯一资源根:`<profileDir>/characters/<characterName>/{live2d,illustration,voice}/`. */
export function charactersDir(): string {
  return path.join(profileDir(), 'characters');
}

/** Server 将内置种子复制到这个位置; 目录已存在时保留用户磁盘上的内容. */
export function builtinSkillsDir(): string {
  return path.join(profileDir(), 'resources', 'skills');
}

/** 主窗口壁纸图库: <profileDir>/wallpapers/<图片文件>. */
export function wallpapersDir(): string {
  return path.join(profileDir(), 'wallpapers');
}

/** 优先读 EMA_BUNDLED_SKILLS_DIR; 未设置时使用源码仓库中的资源路径. */
export function bundledSkillsSource(): string {
  return process.env['EMA_BUNDLED_SKILLS_DIR']
    ?? path.join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'resources', 'skills');
}


export function dataDbPathFor(dataDir: string): string {
  return path.join(dataDir, 'data.db');
}

export function trashDirFor(dataDir: string): string {
  return path.join(dataDir, '.trash');
}

/** 创建数据目录顶层布局;audio 等子目录由各自业务懒建. */
export function ensureDataDirLayout(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(trashDirFor(dataDir), { recursive: true });
}

/** 后台进程日志属于 Session, 不随某个 Turn 结束而删除. */
export function backgroundProcessOutputDirFor(
  dataDir: string,
  sessionId: string,
  backgroundProcessId: string,
): { absoluteDirectory: string; relativeDirectory: string } {
  const absoluteDirectory = path.join(
    sessionResourceDir(dataDir, 'background-processes', sessionId),
    backgroundProcessId,
  );
  return { absoluteDirectory, relativeDirectory: path.relative(dataDir, absoluteDirectory) };
}

/** 不跟随资源根目录或 Session 目录的符号链接, 避免清理越出数据目录. */
function* sessionResourceDirectories(dataDir: string): Generator<{
  sessionId: string;
  directory: string;
}> {
  for (const kind of SESSION_RESOURCE_KINDS) {
    const root = dataResourceDir(dataDir, kind);
    if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      yield { sessionId: entry.name, directory: path.join(root, entry.name) };
    }
  }
}

/** ready 后逐目录容错清理; 一个文件被占用不阻断其他 Session 的回收. */
export function sweepOrphanSessionDirectories(
  dataDir: string,
  sessionExists: (sessionId: string) => boolean,
): { removed: number; failed: number } {
  let removed = 0;
  let failed = 0;
  for (const { sessionId, directory } of sessionResourceDirectories(dataDir)) {
    if (sessionExists(sessionId)) continue;
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

/** 接收请求前清理导入在文件发布后, SQL 提交前退出的残留; 失败阻止启动. */
export function removeOrphanSessionDirectories(
  dataDir: string,
  hasSession: (sessionId: string) => boolean,
): number {
  let removed = 0;
  for (const { sessionId, directory } of sessionResourceDirectories(dataDir)) {
    if (hasSession(sessionId)) continue;
    fs.rmSync(directory, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export function scratchpadTurnDir(dataDir: string, sessionId: string, turnId: string): string {
  return turnResourceDir(dataDir, 'scratchpad', sessionId, turnId);
}

export function ensureScratchpadDir(dataDir: string, sessionId: string, turnId: string): string {
  const dir = scratchpadTurnDir(dataDir, sessionId, turnId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeScratchpadDir(dataDir: string, sessionId: string, turnId: string): void {
  fs.rmSync(scratchpadTurnDir(dataDir, sessionId, turnId), { recursive: true, force: true });
}

/** Turn 数据行删除后清理该轮所有角色音频和临时便签. */
export function removeTurnFiles(dataDir: string, sessionId: string, turnId: string): void {
  fs.rmSync(turnResourceDir(dataDir, 'audio', sessionId, turnId), { recursive: true, force: true });
  removeScratchpadDir(dataDir, sessionId, turnId);
}

/** 只清理数据库中已不存在的 Turn; Session 级下载和工具大文本不按 Turn 回收. */
export function sweepOrphanTurnFiles(
  dataDir: string,
  liveTurnIdsForSession: (sessionId: string) => Set<string>,
): { removed: number } {
  let removed = 0;
  for (const kind of ['audio', 'scratchpad'] as const) {
    const root = dataResourceDir(dataDir, kind);
    if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) continue;
    for (const session of fs.readdirSync(root, { withFileTypes: true })) {
      if (!session.isDirectory() || session.isSymbolicLink() || session.name.startsWith('.')) continue;
      const directory = path.join(root, session.name);
      const live = liveTurnIdsForSession(session.name);
      for (const turn of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!turn.isDirectory() || turn.isSymbolicLink()) continue;
        if (live.has(turn.name)) continue;
        fs.rmSync(path.join(directory, turn.name), { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return { removed };
}

/** Session 数据行删除后清理每类受管资源, 不触碰 Profile 和备份暂存目录. */
export function removeSessionFiles(dataDir: string, sessionId: string): void {
  for (const kind of SESSION_RESOURCE_KINDS) {
    fs.rmSync(sessionResourceDir(dataDir, kind, sessionId), { recursive: true, force: true });
  }
}
