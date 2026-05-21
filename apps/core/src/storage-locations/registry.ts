import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { registryPath, profileDir, ensureDataDirLayout } from './paths.js';

// ── Registry types ───────────────────────────────────────────────────────────

export interface DataDirEntry {
  name:     string;          // user label (unique within registry)
  path:     string;          // absolute filesystem path
  addedAt:  number;
}

export interface Registry {
  /** Name of the entry currently active. Always present after first init. */
  active: string;
  dirs:   DataDirEntry[];
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_DIR_NAME = 'main';

function defaultRegistry(): Registry {
  return {
    active: DEFAULT_DIR_NAME,
    dirs: [{
      name:    DEFAULT_DIR_NAME,
      path:    path.join(os.homedir(), '.ema-agent', 'data'),
      addedAt: Date.now(),
    }],
  };
}

// ── Disk I/O ─────────────────────────────────────────────────────────────────

/**
 * Load the registry from `~/.ema-agent/registry.json`. Initialises a default
 * "main" entry on first run (pointing at `~/.ema-agent/data/`). Always
 * returns a valid Registry — never throws on missing file.
 */
export function loadRegistry(): Registry {
  const fp = registryPath();
  if (!fs.existsSync(fp)) {
    const reg = defaultRegistry();
    saveRegistry(reg);
    ensureDataDirLayout(reg.dirs[0]!.path);
    return reg;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as Partial<Registry>;
    const dirs = Array.isArray(raw.dirs) ? raw.dirs : [];
    if (dirs.length === 0) {
      const reg = defaultRegistry();
      saveRegistry(reg);
      ensureDataDirLayout(reg.dirs[0]!.path);
      return reg;
    }
    const active = typeof raw.active === 'string'
      && dirs.some(d => d.name === raw.active)
      ? raw.active
      : dirs[0]!.name;
    return { active, dirs };
  } catch (err) {
    console.warn('[registry] failed to parse, falling back to default:', err);
    const reg = defaultRegistry();
    saveRegistry(reg);
    return reg;
  }
}

export function saveRegistry(reg: Registry): void {
  fs.mkdirSync(profileDir(), { recursive: true });
  fs.writeFileSync(
    registryPath(),
    JSON.stringify(reg, null, 2),
    { encoding: 'utf8' },
  );
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function activeDirEntry(reg: Registry): DataDirEntry {
  const entry = reg.dirs.find(d => d.name === reg.active);
  if (!entry) {
    // Shouldn't happen post-load, but defensive: pick first.
    return reg.dirs[0]!;
  }
  return entry;
}

export interface AddDirInput {
  name: string;
  path: string;
}

/**
 * Register a new data dir. Returns the updated registry. Throws when:
 *   - name already exists
 *   - path is already registered under another name
 *   - path is empty / not absolute
 *
 * Does NOT create data.db — that's the migration step's job.
 */
export function addDir(reg: Registry, input: AddDirInput): Registry {
  const name = input.name.trim();
  const dirPath = path.resolve(input.path.trim());

  if (!name) throw new Error('registry: name is required');
  if (!dirPath || !path.isAbsolute(dirPath)) {
    throw new Error(`registry: path must be absolute, got "${input.path}"`);
  }
  if (reg.dirs.some(d => d.name === name)) {
    throw new Error(`registry: name "${name}" already exists`);
  }
  if (reg.dirs.some(d => path.resolve(d.path) === dirPath)) {
    throw new Error(`registry: path "${dirPath}" already registered`);
  }

  ensureDataDirLayout(dirPath);
  const next: Registry = {
    active: reg.active,
    dirs:   [...reg.dirs, { name, path: dirPath, addedAt: Date.now() }],
  };
  saveRegistry(next);
  return next;
}

export function removeDir(reg: Registry, name: string): Registry {
  if (reg.dirs.length <= 1) {
    throw new Error('registry: cannot remove the only registered dir');
  }
  if (!reg.dirs.some(d => d.name === name)) {
    throw new Error(`registry: name "${name}" not found`);
  }
  if (reg.active === name) {
    throw new Error(`registry: cannot remove the active dir "${name}"; switch first`);
  }
  const next: Registry = {
    active: reg.active,
    dirs:   reg.dirs.filter(d => d.name !== name),
  };
  saveRegistry(next);
  return next;
}

export function setActive(reg: Registry, name: string): Registry {
  if (!reg.dirs.some(d => d.name === name)) {
    throw new Error(`registry: name "${name}" not found`);
  }
  const next: Registry = { active: name, dirs: reg.dirs };
  saveRegistry(next);
  return next;
}
