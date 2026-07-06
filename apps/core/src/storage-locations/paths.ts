import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

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
    const base = process.env['EMA_BUILTIN_CARDS_DIR'] ?? path.join(process.cwd(), 'apps', 'desktop', 'public', 'cards');
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
 */
export function resolveCardVoiceRefPath(cardId: string, isBuiltin: boolean, relPath: string): string {
  return cardResourcePath(cardId, isBuiltin, relPath);
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
 * Audio and artifact directories are NOT pre-created here — they are
 * created on demand per session via ensureSessionLayout().
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
//     artifacts/{artifactId}

export function sessionDirFor(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'sessions', sessionId);
}

export function sessionAudioDirFor(dataDir: string, sessionId: string): string {
  return path.join(sessionDirFor(dataDir, sessionId), 'audio');
}

export function sessionArtifactsDirFor(dataDir: string, sessionId: string): string {
  return path.join(sessionDirFor(dataDir, sessionId), 'artifacts');
}

/**
 * Create the standard directory tree for a new (or newly accessed) session.
 * Safe to call multiple times — all mkdirSync calls use `recursive: true`.
 */
export function ensureSessionLayout(dataDir: string, sessionId: string): void {
  const audioDir = sessionAudioDirFor(dataDir, sessionId);
  fs.mkdirSync(path.join(audioDir, 'segments'), { recursive: true });
  fs.mkdirSync(path.join(audioDir, 'merged'),   { recursive: true });
  fs.mkdirSync(sessionArtifactsDirFor(dataDir, sessionId), { recursive: true });
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
 * Delete the entire session directory tree.
 * Called when a session is permanently deleted.
 */
export function removeSessionDir(dataDir: string, sessionId: string): void {
  const dir = sessionDirFor(dataDir, sessionId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
