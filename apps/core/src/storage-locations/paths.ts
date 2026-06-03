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

/**
 * Root for character reference audio. Profile-scoped so a card's voice
 * survives dataDir switches. Per-card sub-folder:
 *   `<profileDir>/voiceRefs/<cardId>/<filename>`
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

/** Create the profile-side directories that aren't part of profile.db itself. */
export function ensureProfileLayout(): void {
  fs.mkdirSync(voiceRefsDir(), { recursive: true });
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
