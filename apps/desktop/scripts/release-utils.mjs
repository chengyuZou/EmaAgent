// 提供桌面发布脚本共用的目标平台、摘要、文件树与原子替换能力。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function parseTargetArgument(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--target');
  const explicit = index >= 0 ? argv[index + 1] : undefined;
  return explicit || process.env['TAURI_ENV_TARGET_TRIPLE'] || rustHostTarget();
}

export function rustHostTarget() {
  const verbose = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' });
  const hostLine = verbose.split(/\r?\n/u).find((line) => line.startsWith('host: '));
  if (!hostLine) throw new Error('rustc -Vv 未返回 host target triple');
  return hostLine.slice('host: '.length).trim();
}

export function executableSuffix(target) {
  return target.includes('windows') ? '.exe' : '';
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function requireRegularFile(filePath, label) {
  if (!existsSync(filePath) || !statSync(filePath).isFile() || statSync(filePath).size === 0) {
    throw new Error(`${label} 缺失、不是普通文件或为空: ${filePath}`);
  }
}

export function listRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || lstatSync(absolute).isSymbolicLink()) {
        throw new Error(`发布目录禁止符号链接: ${absolute}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

export function replaceDirectoryAtomically(staging, destination) {
  const backup = `${destination}.previous-${process.pid}`;
  rmSync(backup, { recursive: true, force: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  if (existsSync(destination)) renameSync(destination, backup);
  try {
    renameSync(staging, destination);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    if (existsSync(backup)) renameSync(backup, destination);
    throw error;
  }
}

export function copyExecutable(source, destination, target) {
  requireRegularFile(source, '可执行文件源');
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  copyFileSync(source, temporary);
  if (!target.includes('windows')) chmodSync(temporary, 0o755);
  rmSync(destination, { force: true });
  renameSync(temporary, destination);
}

export function copyTree(source, destination) {
  if (!statSync(source).isDirectory()) throw new Error(`源目录不存在: ${source}`);
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
}
