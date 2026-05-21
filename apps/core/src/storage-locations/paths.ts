import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

// ── Profile (cross-data-dir) ─────────────────────────────────────────────────

/**
 * Always `~/.ema-agent/`. Holds profile.db + registry.json + lockfile.json.
 * Honors the EMA_PROFILE_DIR env var for tests and edge cases — production
 * users never set this.
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

// ── Data dir helpers ─────────────────────────────────────────────────────────

export function dataDbPathFor(dataDir: string): string {
  return path.join(dataDir, 'data.db');
}

export function audioDirFor(dataDir: string): string {
  return path.join(dataDir, 'audio');
}

export function artifactsDirFor(dataDir: string): string {
  return path.join(dataDir, 'artifacts');
}

export function trashDirFor(dataDir: string): string {
  return path.join(dataDir, '.trash');
}

/** Create a freshly-registered dataDir's standard sub-folder layout. */
export function ensureDataDirLayout(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(audioDirFor(dataDir), 'segments'), { recursive: true });
  fs.mkdirSync(path.join(audioDirFor(dataDir), 'merged'),   { recursive: true });
  fs.mkdirSync(artifactsDirFor(dataDir), { recursive: true });
  fs.mkdirSync(trashDirFor(dataDir),     { recursive: true });
}
