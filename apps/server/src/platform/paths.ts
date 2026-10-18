import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 一个 Session 的全部文件收在 sessions/<sessionId>/ 下,删除 Session 即整目录移除:
//   {dataDir}/sessions/{sessionId}/
//     audio/{turnId}/{turnId}-{characterName}.wav
//     audio/{turnId}/{turnId}-{characterName}.wav.pending
//     scratchpad/{turnId}/{key}
//     background-processes/{processId}/

export function sessionDirFor(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'sessions', sessionId);
}

/**
 * 启动自检:删除数据库中已不存在的整棵 Session 目录.
 * 数据库是事实源;逐目录隔离删除失败,避免一个被占用的 Windows 文件阻断其余恢复.
 */
export function sweepOrphanSessionDirectories(
  dataDir: string,
  sessionExists: (sessionId: string) => boolean,
): { removed: number; failed: number } {
  const sessionsRoot = path.join(dataDir, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return { removed: 0, failed: 0 };

  let removed = 0;
  let failed = 0;
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    // 不跟随符号链接或 Junction,避免清理越出 active dataDir.
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (sessionExists(entry.name)) continue;

    try {
      fs.rmSync(path.join(sessionsRoot, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

/** 后台进程日志跟随 Session 生命周期,但不属于某个短命 Turn. */
export function backgroundProcessOutputDirFor(
  dataDir: string,
  sessionId: string,
  backgroundProcessId: string,
): { absoluteDirectory: string; relativeDirectory: string } {
  const relativeDirectory = path.join(
    'sessions',
    sessionId,
    'background-processes',
    backgroundProcessId,
  );
  return { absoluteDirectory: path.join(dataDir, relativeDirectory), relativeDirectory };
}

/**
 * 只删除 Session 下的 artifacts 子目录, 保留 audio, scratchpad 等仍在使用的文件.
 */
export function removeLegacyArtifactDirectories(dataDir: string): number {
  const sessionsRoot = path.join(dataDir, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return 0;

  let removed = 0;
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const artifactDir = path.join(sessionsRoot, entry.name, 'artifacts');
    if (!fs.existsSync(artifactDir)) continue;
    fs.rmSync(artifactDir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * 删除没有对应 Session 数据行的目录, 包括导入在文件落位后, SQL 提交前中断的残留.
 * 点开头的暂存目录保留. 删除失败会向上传播, 与 ready 后逐项容错的清理不同.
 */
export function removeOrphanSessionDirectories(
  dataDir: string,
  hasSession: (sessionId: string) => boolean,
): number {
  const sessionsRoot = path.join(dataDir, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return 0;

  let removed = 0;
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (hasSession(entry.name)) continue;
    fs.rmSync(path.join(sessionsRoot, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}


export function scratchpadTurnDir(dataDir: string, sessionId: string, turnId: string): string {
  return path.join(sessionDirFor(dataDir, sessionId), 'scratchpad', turnId);
}

export function ensureScratchpadDir(dataDir: string, sessionId: string, turnId: string): string {
  const dir = scratchpadTurnDir(dataDir, sessionId, turnId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeScratchpadDir(dataDir: string, sessionId: string, turnId: string): void {
  const dir = scratchpadTurnDir(dataDir, sessionId, turnId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Turn 数据行删除后清理该轮所有角色音频, 未完成写入的文件和 scratchpad.
 */
export function removeTurnFiles(dataDir: string, sessionId: string, turnId: string): void {
  const audioDir = path.join(sessionDirFor(dataDir, sessionId), 'audio', turnId);
  fs.rmSync(audioDir, { recursive: true, force: true });

  removeScratchpadDir(dataDir, sessionId, turnId);
}

/**
 * 启动自检:清理"DB 已删 Turn, 磁盘仍残留"的孤儿文件.
 * 删除数据行后进程可能在文件清理途中退出. 本函数只删除数据库中已不存在
 * 的 Turn 对应音频目录和 scratchpad; 仍存在的 Turn 文件保留.
 * liveTurnIdsForSession 由调用方从 DB 提供, 本函数不猜 Session 是否存在.
 */
export function sweepOrphanTurnFiles(
  dataDir: string,
  liveTurnIdsForSession: (sessionId: string) => Set<string>,
): { removed: number } {
  const sessionsRoot = path.join(dataDir, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return { removed: 0 };

  let removed = 0;
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const sessionId = entry.name;
    const audioDir = path.join(sessionsRoot, sessionId, 'audio');
    const scratchDir = path.join(sessionsRoot, sessionId, 'scratchpad');
    if (!fs.existsSync(audioDir) && !fs.existsSync(scratchDir)) continue;
    const live = liveTurnIdsForSession(sessionId);

    if (fs.existsSync(audioDir)) {
      for (const folder of fs.readdirSync(audioDir, { withFileTypes: true })) {
        if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
        // 这里只清理 Turn 目录; merged / segments 的旧资源清理需单独处理.
        if (folder.name === 'merged' || folder.name === 'segments') continue;
        if (!live.has(folder.name)) {
          fs.rmSync(path.join(audioDir, folder.name), { recursive: true, force: true });
          removed++;
        }
      }
    }

    if (fs.existsSync(scratchDir)) {
      for (const turnId of fs.readdirSync(scratchDir)) {
        if (!live.has(turnId)) {
          fs.rmSync(path.join(scratchDir, turnId), { recursive: true, force: true });
          removed++;
        }
      }
    }
  }
  return { removed };
}

/** 永久删除 Session 时移除整棵目录树. */
export function removeSessionDir(dataDir: string, sessionId: string): void {
  const dir = sessionDirFor(dataDir, sessionId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
