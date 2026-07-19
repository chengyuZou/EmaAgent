// 校验当前目标平台的 Core、Bridge 与 Cubism 发布制品是否完整。
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const tauriRoot = path.join(desktopRoot, 'src-tauri');

function rustTargetTriple() {
  const verbose = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' });
  const hostLine = verbose.split(/\r?\n/u).find((line) => line.startsWith('host: '));
  if (!hostLine) throw new Error('rustc -Vv 未返回 host target triple');
  return hostLine.slice('host: '.length).trim();
}

function requireNonEmptyFile(filePath, label) {
  if (!existsSync(filePath) || !statSync(filePath).isFile() || statSync(filePath).size === 0) {
    throw new Error(`${label} 缺失或为空: ${filePath}`);
  }
}

const target = process.env['TAURI_ENV_TARGET_TRIPLE'] || rustTargetTriple();
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
requireNonEmptyFile(
  path.join(tauriRoot, 'binaries', `ema-core-${target}${executableSuffix}`),
  'Core sidecar',
);
requireNonEmptyFile(
  path.join(tauriRoot, 'binaries', `ema-bridge-${target}${executableSuffix}`),
  'Bridge sidecar',
);
requireNonEmptyFile(
  path.join(desktopRoot, 'public', 'cubism', 'live2dcubismcore.min.js'),
  'Cubism Core',
);

process.stdout.write(`release assets verified for ${target}\n`);
