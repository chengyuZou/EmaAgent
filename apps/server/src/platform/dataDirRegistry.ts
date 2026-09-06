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

/**
 * 摘除注册项。最后一个不可删;删除活动项时 active 自动切到剩余第一个
 * (调用方负责在此之前关闭数据库连接并提示重启)。
 */
export function removeDir(reg: Registry, name: string): Registry {
  if (reg.dirs.length <= 1) {
    throw new Error('registry: cannot remove the only registered dir');
  }
  if (!reg.dirs.some(d => d.name === name)) {
    throw new Error(`registry: name "${name}" not found`);
  }
  const dirs = reg.dirs.filter(d => d.name !== name);
  const next: Registry = {
    active: reg.active === name ? dirs[0]!.name : reg.active,
    dirs,
  };
  saveRegistry(next);
  return next;
}

/**
 * "全部删除"的磁盘侧:只按白名单删 Ema 自己的东西,目录里任何白名单外的
 * 文件/文件夹一个不碰(KB 独立、artifacts 是老垃圾,均不在列)。目录删成空壳
 * 才连目录一起删;有外来遗留就如实报告,绝不对目录整体 rm -rf。
 */
const OWNED_DATA_DIR_ENTRIES: readonly string[] = [
  'data.db',
  'data.db-wal',
  'data.db-shm',
  'data.db-journal',
  'sessions',
  'audio',
  '.trash',
];

export interface DataDirWipeResult {
  readonly removedEntries: string[];
  /** 白名单外未动的目录项(外来文件或 KB/artifacts 等不归本业务的目录)。 */
  readonly leftovers: string[];
  /** 目录本身是否已删(无遗留才删得掉)。 */
  readonly dirRemoved: boolean;
}

export function wipeDataDirContents(dirPath: string): DataDirWipeResult {
  const removedEntries: string[] = [];
  for (const entry of OWNED_DATA_DIR_ENTRIES) {
    const target = path.join(dirPath, entry);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removedEntries.push(entry);
  }
  const leftovers = fs.existsSync(dirPath)
    ? fs.readdirSync(dirPath)
    : [];
  let dirRemoved = false;
  if (leftovers.length === 0 && fs.existsSync(dirPath)) {
    fs.rmdirSync(dirPath);
    dirRemoved = true;
  }
  return { removedEntries, leftovers, dirRemoved };
}

export function setActive(reg: Registry, name: string): Registry {
  if (!reg.dirs.some(d => d.name === name)) {
    throw new Error(`registry: name "${name}" not found`);
  }
  const next: Registry = { active: name, dirs: reg.dirs };
  saveRegistry(next);
  return next;
}
