// 统一计算 EmaAgent 的 Profile、数据目录、Session 与资源文件路径。

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ── Profile（跨数据目录共享） ─────────────────────────────────────────────────

/** 永远 `~/.ema-agent/`：profile.db、lockfile.json、characters/。registry.json 与库注册表已随单库化整体拆除。测试用 EMA_PROFILE_DIR 覆盖。 */
export function profileDir(): string {
  const dir = process.env['EMA_PROFILE_DIR'] ?? path.join(os.homedir(), '.ema-agent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function profileDbPath(): string {
  return path.join(profileDir(), 'profile.db');
}

export function narrativeDbPath(): string {
  const directory = path.join(profileDir(), 'narrative');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, 'narrative.db');
}

/** 返回 SQLite 主文件及其 WAL/SHM 辅助文件。 */
export function sqliteFileSet(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

export function lockfilePath(): string {
  return path.join(profileDir(), 'lockfile.json');
}

/** 唯一数据目录:`~/.ema-agent/data`。固定,不再有库注册表。 */
export function dataDirPath(): string {
  return path.join(profileDir(), 'data');
}

// ── 角色资源包 ────────────────────────────────────────────────────────────────

/** 所有角色的唯一资源根：`<profileDir>/characters/<characterName>/{live2d,illustration,voice}/`。 */
export function charactersDir(): string {
  return path.join(profileDir(), 'characters');
}

/** 内置技能目录：`<profileDir>/resources/skills`，由宿主（Tauri release 资源）在启动时铺好；skills 域不感知打包。 */
export function builtinSkillsDir(): string {
  return path.join(profileDir(), 'resources', 'skills');
}

/** 窗口壁纸资源根：`<profileDir>/wallpapers/{chat,settings}/<图片文件>`, 每窗口一个图库文件夹 */
export function wallpapersDir(): string {
  return path.join(profileDir(), 'wallpapers');
}

/** 内置技能种子来源；只在启动铺设阶段读取，正式包由环境变量传入。 */
export function bundledSkillsSource(): string {
  return process.env['EMA_BUNDLED_SKILLS_DIR']
    ?? path.join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'resources', 'skills');
}

/** 创建 profile 侧不属于 profile.db 本身的目录。 */
export function ensureProfileLayout(): void {
  fs.mkdirSync(charactersDir(), { recursive: true });
  fs.mkdirSync(wallpapersDir(), { recursive: true });
}

// ── 数据目录顶层 ──────────────────────────────────────────────────────────────

export function dataDbPathFor(dataDir: string): string {
  return path.join(dataDir, 'data.db');
}

export function trashDirFor(dataDir: string): string {
  return path.join(dataDir, '.trash');
}

/** 创建数据目录顶层布局；audio 等子目录由各自业务懒建。 */
export function ensureDataDirLayout(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(trashDirFor(dataDir), { recursive: true });
}

// ── Session 级目录 ────────────────────────────────────────────────────────────
//
// 一个 Session 的全部文件收在 sessions/<sessionId>/ 下，删除 Session 即整目录移除：
//   {dataDir}/sessions/{sessionId}/
//     audio/{turnId}.wav
//     audio/{turnId}.wav.pending
//     scratchpad/{turnId}/{key}
//     background-processes/{processId}/

export function sessionDirFor(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'sessions', sessionId);
}

/**
 * 启动自检：删除数据库中已不存在的整棵 Session 目录。
 * 数据库是事实源；逐目录隔离删除失败，避免一个被占用的 Windows 文件阻断其余恢复。
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
    // 不跟随符号链接或 Junction，避免清理越出 active dataDir。
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

/** 后台进程日志跟随 Session 生命周期，但不属于某个短命 Turn。 */
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

export function sessionAudioDirFor(dataDir: string, sessionId: string): string {
  return path.join(sessionDirFor(dataDir, sessionId), 'audio');
}

/**
 * Artifact 数据表已由迁移删除，但迁移触不到旧 Session 的物理目录。
 * 启动恢复只删除这个已废弃的固定子目录，不扫描或改动 audio、scratchpad 等现行业务文件。
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
 * 启动对账:删除有目录无 Session 行的尸体(导入在文件落位后、事务提交前
 * 崩溃留下的半截目录;SQL 事务天然回滚不会留行,所以只剩这一种形态)。
 * 点开头的是导入 staging 目录,不碰;启动时无导入在进行,不会误删活人。
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

// ── Turn 级 scratchpad ────────────────────────────────────────────────────────

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
 * Turn 数据行删除后清理对应 WAV、未完成写入的文件和 scratchpad.
 */
export function removeTurnFiles(dataDir: string, sessionId: string, turnId: string): void {
  const audioDir = path.join(sessionDirFor(dataDir, sessionId), 'audio');

  fs.rmSync(path.join(audioDir, `${turnId}.wav`), { force: true });
  fs.rmSync(path.join(audioDir, `${turnId}.wav.pending`), { force: true });

  removeScratchpadDir(dataDir, sessionId, turnId);
}

/**
 * 启动自检：清理"DB 已删 Turn、磁盘仍残留"的孤儿文件。
 * 删除数据行后进程可能在文件清理途中退出. 本函数只删除数据库中已不存在
 * 的 Turn 对应 WAV、pending 和 scratchpad; 仍存在的 Turn 文件保留.
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
      for (const file of fs.readdirSync(audioDir, { withFileTypes: true })) {
        if (!file.isFile() || file.isSymbolicLink()) continue;
        let turnId: string;
        if (file.name.endsWith('.wav.pending')) {
          turnId = file.name.slice(0, -'.wav.pending'.length);
        } else if (file.name.endsWith('.wav')) {
          turnId = file.name.slice(0, -'.wav'.length);
        } else {
          continue;
        }
        if (!live.has(turnId)) {
          fs.rmSync(path.join(audioDir, file.name), { force: true });
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

/** 永久删除 Session 时移除整棵目录树。 */
export function removeSessionDir(dataDir: string, sessionId: string): void {
  const dir = sessionDirFor(dataDir, sessionId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
