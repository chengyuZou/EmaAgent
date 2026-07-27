// 统一计算 EmaAgent 的 Profile、数据、Session 和资源文件路径。

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件位于 apps/localHost/src/storage-locations/ —— 回仓库根用于定位 builtin 资源
// (apps/desktop/public/cards)。用 import.meta.dirname 而非 process.cwd(),因为
// sidecar 经 pnpm 在 apps/localHost 跑 tsx watch,process.cwd() 是 apps/localHost 而非仓库根
// (catalog 路径在 bindings.ts 用同款写法,见 bug 3.1c)。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ── Profile (cross-data-dir) ─────────────────────────────────────────────────

/**
 * Always `~/.ema-agent/`. Holds profile.db + registry.json + lockfile.json
 * + voiceRefs/ + global memory (L0 entity graph, L2 episodic items).
 * Honors EMA_PROFILE_DIR env var for tests.
 */
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

// ── Voice reference audio (profile-scoped) ───────────────────────────────────
// @deprecated Use cardDir(cardId, isBuiltin) + 'voiceRefs' instead.
// Kept for backward compatibility during the V2 migration.

/**
 * Root for character reference audio. Profile-scoped so a card's voice
 * survives dataDir switches. Per-card sub-folder:
 *   `<profileDir>/voiceRefs/<cardId>/<filename>`
 *
 * @deprecated — user-uploaded voice-refs now live under
 *   `~/.ema-agent/cards/<cardId>/voiceRefs/`. This function is kept only
 *   for migration of legacy voice-ref paths. New code should use
 *   cardDir(cardId, false) + 'voiceRefs'.
 */
export function voiceRefsDir(): string {
  return path.join(profileDir(), 'voiceRefs');
}

export function voiceRefsForCard(cardId: string): string {
  return path.join(voiceRefsDir(), cardId);
}

export function resolveVoiceRefPath(relPath: string): string {
  return path.join(voiceRefsDir(), relPath);
}

// ── Character card resource packs ────────────────────────────────────────────

/**
 * Root for user character card resource packs. Each card gets a sub-directory:
 *   `<profileDir>/cards/<cardId>/`
 *     ├── live2d/        (model files + runtime-config.json)
 *     └── voiceRefs/     (reference audio)
 */
export function cardsDir(): string {
  return path.join(profileDir(), 'cards');
}

/**
 * Path to a character card's resource directory.
 *
 * Builtin cards (isBuiltin=true): packaged in `public/cards/<cardId>/`,
 * read-only, served by the Tauri webview. The EMA_BUILTIN_CARDS_DIR env
 * var overrides the default (used in dev to point at apps/desktop/public).
 *
 * User cards (isBuiltin=false): `~/.ema-agent/cards/<cardId>/`, read-write.
 */
export function cardDir(cardId: string, isBuiltin: boolean): string {
  if (isBuiltin) {
    // builtin 卡资源在 apps/desktop/public/cards/<cardId>/,从仓库根拼
    // (process.cwd() 在 tsx watch 下是 apps/localHost,不是仓库根,会导致路径错误 →
    // runtime-config 404 → Live2D 加载失败卡第 0 帧)
    const base = process.env['EMA_BUILTIN_CARDS_DIR'] ?? path.join(REPO_ROOT, 'apps', 'desktop', 'public', 'cards');
    return path.join(base, cardId);
  }
  return path.join(cardsDir(), cardId);
}

/**
 * Resolve a relative path inside a card's resource pack to an absolute path.
 *
 * @param cardId    The card's id (e.g. 'ema').
 * @param isBuiltin Whether the card is builtin (read from public/) or user.
 * @param relPath   Relative path inside the card pack (e.g. 'live2d/ema.model3.json'
 *                  or 'voiceRefs/ra_ema001.mp3').
 */
export function cardResourcePath(cardId: string, isBuiltin: boolean, relPath: string): string {
  return path.join(cardDir(cardId, isBuiltin), relPath);
}

/**
 * Resolve a voice-ref relative path inside a card's resource pack.
 *
 * For builtin cards, this returns the path inside `public/cards/<cardId>/voiceRefs/`.
 * For user cards, `~/.ema-agent/cards/<cardId>/voiceRefs/`.
 *
 * The relPath stored in CharacterRefAudio.refAudioPath is relative to the
 * card pack root (e.g. 'voiceRefs/ra_ema001.mp3').
 *
 * B-055 路径安全: 与 character-card 类型契约一致, 只允许 `voiceRefs/<单层文件名>`——
 * 拒绝绝对路径, `..` 逃逸, 反斜杠与子目录。refAudioPath 来自数据库(可能被构造),
 * 此函数是 GET 音频流, DELETE 文件, TTS 克隆上传与 GPT-SoVITS 读文件共用的
 * 唯一咽喉点, 越界一律抛 invalid_voice_ref_path。
 */
export function resolveCardVoiceRefPath(cardId: string, isBuiltin: boolean, relPath: string): string {
  if (relPath.includes('\\')) {
    throw new Error(`invalid_voice_ref_path: ${relPath}`);
  }
  const match = /^voiceRefs\/([^/]+)$/.exec(relPath);
  const filename = match?.[1];
  if (!filename || filename === '.' || filename === '..') {
    throw new Error(`invalid_voice_ref_path: ${relPath}`);
  }
  return path.join(cardDir(cardId, isBuiltin), 'voiceRefs', filename);
}

/** Create the profile-side directories that aren't part of profile.db itself. */
export function ensureProfileLayout(): void {
  fs.mkdirSync(voiceRefsDir(), { recursive: true });
  fs.mkdirSync(cardsDir(), { recursive: true });
}

// ── Data dir (top-level) ─────────────────────────────────────────────────────

export function dataDbPathFor(dataDir: string): string {
  return path.join(dataDir, 'data.db');
}

export function trashDirFor(dataDir: string): string {
  return path.join(dataDir, '.trash');
}

/**
 * Create the top-level dataDir layout.
 * Audio directories are not pre-created here; AudioArchive writes them lazily.
 */
export function ensureDataDirLayout(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(trashDirFor(dataDir), { recursive: true });
}

// ── Session-scoped directories ────────────────────────────────────────────────
//
// All session-specific files live under sessions/<sessionId>/ so an entire
// session's files can be cleaned up with a single directory removal.
//
// Layout:
//   {dataDir}/sessions/{sessionId}/
//     audio/
//       segments/{turnId}/{n}.{ext}
//       merged/{turnId}.{ext}

export function sessionDirFor(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'sessions', sessionId);
}

export function sessionAudioDirFor(dataDir: string, sessionId: string): string {
  return path.join(sessionDirFor(dataDir, sessionId), 'audio');
}

/**
 * Artifact 数据表由迁移删除，但数据库迁移无法触及旧 Session 的物理目录。
 * 启动恢复只删除已废弃的固定子目录，不扫描或改动 Audio、Scratchpad 等现行业务文件。
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

// ── Turn-scoped scratchpad ────────────────────────────────────────────────────
//
// Temporary shared storage for the main agent and its sub-agents within one
// turn. Each key maps to a file; the entire directory is deleted on turn end.
//
// Layout:
//   {dataDir}/sessions/{sessionId}/scratchpad/{turnId}/{key}

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
 * 删除级联后被删 turn 的物理残留: 音频分段目录、合并音频文件、scratchpad 目录。
 * best-effort 逐 turn 调用——单个失败不阻断其余清理(DB 是事实源, 文件是派生物)。
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
 * 启动自检: 清理"DB 已删 turn, 磁盘仍残留"的孤儿文件。
 * 场景: 删除级联提交 DB 后进程在逐 turn 文件清理中途崩溃——DB 是唯一事实源,
 * 磁盘上不在 live 集合里的音频分段目录/合并音频文件/scratchpad 目录全部清除。
 * liveTurnIdsForSession 由调用方从 DB 提供, 本函数不猜 session 是否存在。
 */
export function sweepOrphanTurnFiles(
  dataDir: string,
  liveTurnIdsForSession: (sessionId: string) => Set<string>,
): { removed: number } {
  const sessionsRoot = path.join(dataDir, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return { removed: 0 };

  let removed = 0;
  for (const sessionId of fs.readdirSync(sessionsRoot)) {
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
        // 文件名形如 {turnId}.{ext}; turnId 是不含点的 UUID。
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

/**
 * Delete the entire session directory tree.
 * Called when a session is permanently deleted.
 */
export function removeSessionDir(dataDir: string, sessionId: string): void {
  const dir = sessionDirFor(dataDir, sessionId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
