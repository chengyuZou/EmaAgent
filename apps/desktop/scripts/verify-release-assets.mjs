// 严格验证当前目标平台的 Server 制品、Narrative SQL 资产与 Cubism 发布制品。
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
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

// Rust 按角色最终目录名整树复制。这里直接验证发布包来源，避免打包前又退回 ASCII 别名目录。
const characterSource = path.join(tauriRoot, 'resources', 'characters', '樱羽艾玛');
requireRegularFile(
  path.join(characterSource, 'live2d', 'ema', 'ema.model3.json'),
  '艾玛 Live2D 入口',
);
requireRegularFile(
  path.join(characterSource, 'voice', 'ra_ema001.mp3'),
  '艾玛参考音频',
);

// 剧情 SQL 随 Storage 包进入 Server 依赖, 不再另外携带 Bridge 数据目录.
const narrativeSqlRoot = path.join(
  serverResource, 'app', 'node_modules', '@ema-agent', 'storage', 'dist', 'migrations', 'narrative',
);
for (const filename of [
  'narrative.sql', 'narrative-cache.sql',
  'narrative-seeds-1st.sql', 'narrative-seeds-2nd.sql', 'narrative-seeds-3rd.sql',
]) {
  requireRegularFile(path.join(narrativeSqlRoot, filename), `Narrative SQL: ${filename}`);
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
process.stdout.write(`release assets verified for ${target}\n`);
