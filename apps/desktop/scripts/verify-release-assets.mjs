// 严格验证当前目标平台的 Server 制品、Narrative Bridge 二进制、Narrative 剧情数据与 Cubism 发布制品。
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  executableSuffix,
  parseTargetArgument,
  readJson,
  requireRegularFile,
  sha256File,
} from './release-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const workspaceRoot = path.resolve(desktopRoot, '..', '..');
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

const serverBinary = path.join(tauriRoot, 'binaries', `ema-server-${target}${suffix}`);
const serverResource = path.join(tauriRoot, 'resources', 'server');
const serverManifest = readJson(path.join(serverResource, 'release-manifest.json'));
const serverEntry = path.join(serverResource, ...serverManifest.entry.split('/'));
requireExecutable(serverBinary, 'Server 可执行文件');
requireRegularFile(serverEntry, 'Server 入口');
if (serverManifest.target !== target || serverManifest.nodeVersion !== config.nodeVersion) {
  throw new Error('Server release manifest 的 target 或 Node 版本不匹配');
}
if (sha256File(serverEntry) !== serverManifest.entrySha256) {
  throw new Error('Server 入口摘要与 manifest 不匹配');
}
const narrativeBridgeResource = path.join(tauriRoot, 'resources', 'narrative-bridge');
const narrativeBridgeBinary = path.join(narrativeBridgeResource, `ema-narrative-bridge${suffix}`);
requireExecutable(narrativeBridgeBinary, 'Narrative Bridge 可执行文件');
const narrativeBridgeManifestPath = path.join(narrativeBridgeResource, 'release-manifest.json');
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
  throw new Error('Narrative Bridge 可执行文件大小或摘要与 manifest 不匹配');
}

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

// Narrative 剧情数据从 bridges/narrative/data 直收进安装包：验证源目录三时间线齐备。
const narrativeSource = path.join(workspaceRoot, 'bridges', 'narrative', 'data', 'witch-trial');
for (const timeline of ['1st_Loop', '2nd_Loop', '3rd_Loop']) {
  const timelineDir = path.join(narrativeSource, timeline);
  if (!existsSync(timelineDir) || !statSync(timelineDir).isDirectory()) {
    throw new Error(`Narrative 剧情数据缺少时间线目录: ${timeline}`);
  }
}

const smokeScript = path.join(scriptDirectory, 'smoke-services.mjs');
execFileSync(
  process.execPath,
  [
    smokeScript,
    '--service',
    'server',
    '--executable',
    serverBinary,
    '--entry',
    serverEntry,
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
    narrativeSource,
  ],
  { stdio: 'inherit' },
);

process.stdout.write(`release assets verified for ${target}\n`);
