import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function parseTargetArgument(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--target');
  if (index >= 0) {
    const explicit = argv[index + 1];
    if (!explicit || explicit.startsWith('--')) {
      throw new Error('--target 后面需要目标平台名称');
    }
    return explicit;
  }
  return process.env['TAURI_ENV_TARGET_TRIPLE'] || rustHostTarget();
}

export function rustHostTarget() {
  const verbose = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' });
  const hostLine = verbose.split(/\r?\n/u).find((line) => line.startsWith('host: '));
  if (!hostLine) {
    throw new Error('rustc -Vv 未返回 host target triple');
  }
  return hostLine.slice('host: '.length).trim();
}

export function executableSuffix(target) {
  return target.includes('windows') ? '.exe' : '';
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function requireRegularFile(filePath, label) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch (error) {
    throw new Error(`${label} 不可读取: ${filePath}`, { cause: error });
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${label} 不是普通文件或为空: ${filePath}`);
  }
}
