// 严格验证当前目标平台的 Sidecar、LocalHost runtime、Narrative seed 与 Cubism 发布制品。
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  executableSuffix,
  listRegularFiles,
  parseTargetArgument,
  readJson,
  requireRegularFile,
  sha256File,
} from './release-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const tauriRoot = path.join(desktopRoot, 'src-tauri');
const config = readJson(path.join(desktopRoot, 'release-config.json'));
const target = parseTargetArgument();
const suffix = executableSuffix(target);

function requireExecutable(filePath, label) {
  requireRegularFile(filePath, label);
  if (!target.includes('windows') && (statSync(filePath).mode & 0o111) === 0) {
    throw new Error(`${label} 缺少 Unix executable bit: ${filePath}`);
  }
}

const localHostBinary = path.join(tauriRoot, 'binaries', `ema-local-host-${target}${suffix}`);
const localHostRuntime = path.join(tauriRoot, 'resources', 'local-host-runtime');
const localHostManifest = readJson(path.join(localHostRuntime, 'release-manifest.json'));
const localHostEntry = path.join(localHostRuntime, ...localHostManifest.entry.split('/'));
requireExecutable(localHostBinary, 'LocalHost sidecar');
requireRegularFile(localHostEntry, 'LocalHost runtime 入口');
if (localHostManifest.target !== target || localHostManifest.nodeVersion !== config.nodeVersion) {
  throw new Error('LocalHost release manifest 的 target 或 Node 版本不匹配');
}
if (sha256File(localHostEntry) !== localHostManifest.entrySha256) {
  throw new Error('LocalHost runtime 入口摘要与 manifest 不匹配');
}
const actualNodeVersion = execFileSync(localHostBinary, ['--version'], { encoding: 'utf8' }).trim();
if (actualNodeVersion !== `v${config.nodeVersion}`) {
  throw new Error(`LocalHost sidecar Node 版本错误: ${actualNodeVersion}`);
}

const narrativeBridgeRuntime = path.join(tauriRoot, 'resources', 'narrative-bridge-runtime');
const narrativeBridgeBinary = path.join(narrativeBridgeRuntime, `ema-narrative-bridge${suffix}`);
const narrativeBridgeManifestPath = path.join(narrativeBridgeRuntime, 'release-manifest.json');
requireExecutable(narrativeBridgeBinary, 'Narrative Bridge sidecar');
requireRegularFile(narrativeBridgeManifestPath, 'Narrative Bridge release manifest');
const narrativeBridgeManifest = readJson(narrativeBridgeManifestPath);
if (
  narrativeBridgeManifest.target !== target
  || narrativeBridgeManifest.fileName !== path.basename(narrativeBridgeBinary)
) {
  throw new Error('Narrative Bridge release manifest 的 target 或文件名不匹配');
}
if (
  narrativeBridgeManifest.size !== statSync(narrativeBridgeBinary).size
  || narrativeBridgeManifest.sha256 !== sha256File(narrativeBridgeBinary)
) {
  throw new Error('Narrative Bridge Sidecar 大小或摘要与 manifest 不匹配');
}
execFileSync(narrativeBridgeBinary, ['--version'], { stdio: 'inherit' });

const cubismPath = path.join(
  desktopRoot,
  'public',
  'cubism',
  config.cubismCore.fileName,
);
requireRegularFile(cubismPath, 'Cubism Core');
const cubismHash = sha256File(cubismPath);
if (!config.cubismCore.allowedSha256.includes(cubismHash)) {
  throw new Error(`Cubism Core SHA-256 未被批准: ${cubismHash}`);
}

const narrativeRoot = path.join(tauriRoot, 'resources', 'narrative-seed');
const narrativeManifestPath = path.join(narrativeRoot, 'release-manifest.json');
requireRegularFile(narrativeManifestPath, 'Narrative seed manifest');
const narrativeManifest = readJson(narrativeManifestPath);
if (
  narrativeManifest.schemaVersion !== 1
  || narrativeManifest.contentVersion !== config.narrativeSeed.contentVersion
) {
  throw new Error('Narrative seed manifest 版本不匹配');
}
for (const [relativePath, expected] of Object.entries(narrativeManifest.files)) {
  const filePath = path.join(narrativeRoot, ...relativePath.split('/'));
  requireRegularFile(filePath, `Narrative seed ${relativePath}`);
  if (statSync(filePath).size !== expected.size || sha256File(filePath) !== expected.sha256) {
    throw new Error(`Narrative seed 文件摘要不匹配: ${relativePath}`);
  }
}
const narrativeFiles = listRegularFiles(narrativeRoot);
for (const excludedName of config.narrativeSeed.excludedFileNames) {
  if (narrativeFiles.some((relativePath) => path.posix.basename(relativePath) === excludedName)) {
    throw new Error(`Narrative seed 混入可再生缓存: ${excludedName}`);
  }
}
if (!existsSync(path.join(narrativeRoot, '1st_Loop'))
  || !existsSync(path.join(narrativeRoot, '2nd_Loop'))
  || !existsSync(path.join(narrativeRoot, '3rd_Loop'))) {
  throw new Error('Narrative seed 缺少必需时间线');
}

const smokeScript = path.join(scriptDirectory, 'smoke-runtime-service.mjs');
execFileSync(
  process.execPath,
  [
    smokeScript,
    '--service',
    'local-host',
    '--executable',
    localHostBinary,
    '--entry',
    localHostEntry,
  ],
  { stdio: 'inherit' },
);
execFileSync(
  process.execPath,
  [
    smokeScript,
    '--service',
    'narrative-bridge',
    '--executable',
    narrativeBridgeBinary,
    '--narrative',
    narrativeRoot,
  ],
  { stdio: 'inherit' },
);

process.stdout.write(`release assets verified for ${target}\n`);
