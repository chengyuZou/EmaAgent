// 构建可搬迁的 Core 生产目录，并把当前平台 Node 运行时装配为 Tauri Sidecar。
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  copyExecutable,
  executableSuffix,
  listRegularFiles,
  parseTargetArgument,
  readJson,
  replaceDirectoryAtomically,
  requireRegularFile,
  rustHostTarget,
  sha256File,
} from './release-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const workspaceRoot = path.resolve(desktopRoot, '..', '..');
const tauriRoot = path.join(desktopRoot, 'src-tauri');
const config = readJson(path.join(desktopRoot, 'release-config.json'));
const target = parseTargetArgument();
const hostTarget = rustHostTarget();

if (target !== hostTarget) {
  throw new Error(`Core 原生依赖必须在目标平台构建: target=${target}, host=${hostTarget}`);
}
if (process.version !== `v${config.nodeVersion}`) {
  throw new Error(`发布 Node 版本必须是 ${config.nodeVersion}，当前是 ${process.version}`);
}

const stagingRoot = path.join(tauriRoot, '.release-staging', `core-${process.pid}`);
const stagingApp = path.join(stagingRoot, 'app');
const runtimeRoot = path.join(tauriRoot, 'resources', 'core-runtime');
const binaryPath = path.join(
  tauriRoot,
  'binaries',
  `ema-core-${target}${executableSuffix(target)}`,
);

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

execFileSync('pnpm', ['--filter', '@ema-agent/core...', 'build'], {
  cwd: workspaceRoot,
  stdio: 'inherit',
});
execFileSync('pnpm', ['--filter', '@ema-agent/core', 'deploy', '--prod', stagingApp], {
  cwd: workspaceRoot,
  stdio: 'inherit',
});

const entryPath = path.join(stagingApp, 'dist', 'index.js');
requireRegularFile(entryPath, 'Core 入口');
requireRegularFile(path.join(stagingApp, 'dist', 'models-dev-snapshot.json'), '模型目录快照');

const smokePath = path.join(stagingApp, '.release-native-smoke.mjs');
writeFileSync(
  smokePath,
  [
    "import { createRequire } from 'node:module';",
    "const storageRequire = createRequire(import.meta.resolve('@ema-agent/storage'));",
    "const knowledgeBaseRequire = createRequire(import.meta.resolve('@ema-agent/knowledge-base'));",
    "const Database = storageRequire('better-sqlite3');",
    "const sharp = knowledgeBaseRequire('sharp');",
    "const db = new Database(':memory:');",
    "db.exec('CREATE TABLE smoke (id INTEGER PRIMARY KEY)');",
    'db.close();',
    'await sharp({ create: { width: 1, height: 1, channels: 4, background: "#000000" } })',
    '  .png()',
    '  .toBuffer();',
    "process.stdout.write('core native modules ready\\n');",
  ].join('\n'),
  'utf8',
);
execFileSync(process.execPath, [smokePath], { cwd: stagingApp, stdio: 'inherit' });
rmSync(smokePath, { force: true });
execFileSync(
  process.execPath,
  [
    path.join(scriptDirectory, 'smoke-runtime-service.mjs'),
    '--service',
    'core',
    '--executable',
    process.execPath,
    '--entry',
    entryPath,
  ],
  { cwd: workspaceRoot, stdio: 'inherit' },
);

const files = listRegularFiles(stagingApp);
const manifest = {
  schemaVersion: 1,
  target,
  nodeVersion: process.versions.node,
  nodeModulesAbi: process.versions.modules,
  napiVersion: process.versions.napi,
  entry: 'app/dist/index.js',
  entrySha256: sha256File(entryPath),
  fileCount: files.length,
};
writeFileSync(
  path.join(stagingRoot, 'release-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

replaceDirectoryAtomically(stagingRoot, runtimeRoot);
copyExecutable(process.execPath, binaryPath, target);
process.stdout.write(`Core sidecar prepared for ${target}\n`);
