// 统一计算 EmaAgent 的 Profile、数据目录、Session 与资源文件路径。

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 开发期从 Desktop 宿主的发布资源目录找随包种子；正式包由环境变量传入资源目录。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ── Profile（跨数据目录共享） ─────────────────────────────────────────────────

/** 永远 `~/.ema-agent/`：profile.db、registry.json、lockfile.json、characters/。测试用 EMA_PROFILE_DIR 覆盖。 */
export function profileDir(): string {
  const dir = process.env['EMA_PROFILE_DIR'] ?? path.join(os.homedir(), '.ema-agent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function profileDbPath(): string {
  return path.join(profileDir(), 'profile.db');
}

/** 返回 SQLite 主文件及其 WAL/SHM 辅助文件。 */
export function sqliteFileSet(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

export function registryPath(): string {
  return path.join(profileDir(), 'registry.json');
}

export function lockfilePath(): string {
  return path.join(profileDir(), 'lockfile.json');
}

// ── 角色资源包 ────────────────────────────────────────────────────────────────

/** 所有角色的唯一运行时资源根：`<profileDir>/characters/<directoryName>/{live2d,illustration,voice}/`。 */
export function charactersDir(): string {
  return path.join(profileDir(), 'characters');
}

/** 随包角色种子来源；只在安装阶段读取，不是运行时资源根。 */
export function bundledCharactersDir(): string {
  return process.env['EMA_BUNDLED_CHARACTERS_DIR']
    ?? path.join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'resources', 'characters');
}

/** 内置技能目录：`<profileDir>/resources/skills`，由宿主（Tauri release 资源）在启动时铺好；skills 域不感知打包。 */
export function builtinSkillsDir(): string {
  return path.join(profileDir(), 'resources', 'skills');
}

/** 创建 profile 侧不属于 profile.db 本身的目录。 */
export function ensureProfileLayout(): void {
  fs.mkdirSync(charactersDir(), { recursive: true });
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
//     audio/segments/{turnId}/{n}.{ext}
//     audio/merged/{turnId}.{ext}
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
 * 删除级联后被删 Turn 的物理残留：音频分段目录、合并音频文件、scratchpad 目录。
 * best-effort 逐 Turn 调用——单个失败不阻断其余清理（DB 是事实源，文件是派生物）。
 */
export function removeTurnFiles(dataDir: string, sessionId: string, turnId: string): void {
  const audioDir = path.join(sessionDirFor(dataDir, sessionId), 'audio');

  const segmentsDir = path.join(audioDir, 'segments', turnId);
  if (fs.existsSync(segmentsDir)) {
    fs.rmSync(segmentsDir, { recursive: true, force: true });
  }

  const mergedDir = path.join(audioDir, 'merged');
  if (fs.existsSync(mergedDir)) {
    for (const file of fs.readdirSync(mergedDir)) {
      if (file.startsWith(`${turnId}.`)) {
        fs.rmSync(path.join(mergedDir, file), { force: true });
      }
    }
  }

  removeScratchpadDir(dataDir, sessionId, turnId);
}

/**
 * 启动自检：清理"DB 已删 Turn、磁盘仍残留"的孤儿文件。
 * 场景：删除级联提交 DB 后进程在逐 Turn 文件清理中途崩溃。DB 是唯一事实源，
 * 磁盘上不在 live 集合里的音频分段、合并音频、scratchpad 全部清除。
 * liveTurnIdsForSession 由调用方从 DB 提供，本函数不猜 Session 是否存在。
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

    const segmentsDir = path.join(audioDir, 'segments');
    if (fs.existsSync(segmentsDir)) {
      for (const turnId of fs.readdirSync(segmentsDir)) {
        if (!live.has(turnId)) {
          fs.rmSync(path.join(segmentsDir, turnId), { recursive: true, force: true });
          removed++;
        }
      }
    }

    const mergedDir = path.join(audioDir, 'merged');
    if (fs.existsSync(mergedDir)) {
      for (const file of fs.readdirSync(mergedDir)) {
        // 文件名形如 {turnId}.{ext}；turnId 是不含点的 UUID。
        const turnId = file.split('.')[0]!;
        if (!live.has(turnId)) {
          fs.rmSync(path.join(mergedDir, file), { force: true });
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
