// 构建可搬迁的 Server 生产目录，并把当前平台 Node 装配为桌面宿主子进程。
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
  throw new Error(`Server 原生依赖必须在目标平台构建: target=${target}, host=${hostTarget}`);
}
if (process.version !== `v${config.nodeVersion}`) {
  throw new Error(`发布 Node 版本必须是 ${config.nodeVersion}，当前是 ${process.version}`);
}

const stagingRoot = path.join(tauriRoot, '.release-staging', `server-${process.pid}`);
const stagingApp = path.join(stagingRoot, 'app');
const serverResourceRoot = path.join(tauriRoot, 'resources', 'server');
const binaryPath = path.join(
  tauriRoot,
  'binaries',
  `ema-server-${target}${executableSuffix(target)}`,
);

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

execFileSync('pnpm', ['--filter', '@ema-agent/server...', 'build'], {
  cwd: workspaceRoot,
  stdio: 'inherit',
});
execFileSync('pnpm', ['--filter', '@ema-agent/server', 'deploy', '--prod', stagingApp], {
  cwd: workspaceRoot,
  stdio: 'inherit',
});

const entryPath = path.join(stagingApp, 'dist', 'main.js');
requireRegularFile(entryPath, 'Server 入口');

const smokePath = path.join(stagingApp, '.release-native-smoke.mjs');
writeFileSync(
  smokePath,
  [
    "import { createRequire } from 'node:module';",
    "const storageRequire = createRequire(import.meta.resolve('@ema-agent/storage'));",
    "const knowledgeRequire = createRequire(import.meta.resolve('@ema-agent/knowledge'));",
    "const Database = storageRequire('better-sqlite3');",
    "const sharp = knowledgeRequire('sharp');",
    "const db = new Database(':memory:');",
    "db.exec('CREATE TABLE smoke (id INTEGER PRIMARY KEY)');",
    'db.close();',
    'await sharp({ create: { width: 1, height: 1, channels: 4, background: "#000000" } })',
    '  .png()',
    '  .toBuffer();',
    "process.stdout.write('server native modules ready\\n');",
  ].join('\n'),
  'utf8',
);
execFileSync(process.execPath, [smokePath], { cwd: stagingApp, stdio: 'inherit' });
rmSync(smokePath, { force: true });
execFileSync(
  process.execPath,
  [
    path.join(scriptDirectory, 'smoke-services.mjs'),
    '--service',
    'server',
    '--executable',
    process.execPath,
    '--entry',
    entryPath,
  ],
  { cwd: workspaceRoot, stdio: 'inherit' },
);

const files = listRegularFiles(stagingApp);
const manifest = {
  target,
  nodeVersion: process.versions.node,
  entry: 'app/dist/main.js',
  entrySha256: sha256File(entryPath),
};
writeFileSync(
  path.join(stagingRoot, 'release-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

replaceDirectoryAtomically(stagingRoot, serverResourceRoot);
copyExecutable(process.execPath, binaryPath, target);
process.stdout.write(`server bundle prepared for ${target}\n`);
