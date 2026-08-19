// 多数据目录注册表：`~/.ema-agent/registry.json` 记录全部已注册数据目录与当前活动项。
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { registryPath, profileDir, ensureDataDirLayout } from './paths.js';

export interface DataDirEntry {
  /** 用户可见标签，注册表内唯一。 */
  name:     string;
  /** 绝对路径。 */
  path:     string;
  addedAt:  number;
}

export interface Registry {
  /** 当前活动目录名；首次初始化后永远存在。 */
  active: string;
  dirs:   DataDirEntry[];
}

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

/**
 * 读取注册表；首次运行初始化默认 "main" 项（指向 `~/.ema-agent/data/`）。
 * 缺文件或解析失败都回退默认，绝不抛错。
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
    console.warn('[registry] 解析失败，回退默认值:', err);
    const reg = defaultRegistry();
    saveRegistry(reg);
    return reg;
  }
}

export function saveRegistry(reg: Registry): void {
  fs.mkdirSync(profileDir(), { recursive: true });
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2), { encoding: 'utf8' });
}

export function activeDirEntry(reg: Registry): DataDirEntry {
  const entry = reg.dirs.find(d => d.name === reg.active);
  // loadRegistry 已保证 active 命中；此分支只防御手工改坏的 registry.json。
  return entry ?? reg.dirs[0]!;
}

export interface AddDirInput {
  name: string;
  path: string;
}

/**
 * 注册新数据目录。name 重名、path 已注册、path 非绝对路径时抛错。
 * 只建目录布局，不建 data.db——那是迁移步骤的职责。
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
