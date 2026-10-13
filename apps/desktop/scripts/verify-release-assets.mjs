// 检查发布资源, 并用随包 Node 在临时应用目录中完成一次 Server 首次启动.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  executableSuffix,
  parseTargetArgument,
  readJson,
  requireRegularFile,
  rustHostTarget,
  sha256File,
} from './release-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const tauriRoot = path.join(desktopRoot, 'src-tauri');
const config = readJson(path.join(desktopRoot, 'release-config.json'));
const target = parseTargetArgument();
const serverOnly = process.argv.includes('--server-only');
const appRoot = path.join(tauriRoot, 'resources', 'server', 'app');
const serverEntry = path.join(appRoot, 'dist', 'main.js');
const serverBinary = path.join(tauriRoot, 'binaries', `ema-server-${target}${executableSuffix(target)}`);
const charactersSource = path.join(tauriRoot, 'resources', 'characters');
const characterSource = path.join(charactersSource, '樱羽艾玛');

verifyDesktopVersion();
if (target !== rustHostTarget()) {
  throw new Error(`发布检查必须在目标平台运行: ${target}`);
}
requireRegularFile(serverBinary, '随包 Node');
if (!target.includes('windows') && (statSync(serverBinary).mode & 0o111) === 0) {
  throw new Error(`随包 Node 缺少执行权限: ${serverBinary}`);
}
requireRegularFile(serverEntry, 'Server 入口');

// 读取实际二进制的版本和平台, 不依赖准备脚本自行填写的版本清单.
const nodeInfo = JSON.parse(execFileSync(serverBinary, [
  '--eval',
  'process.stdout.write(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch}))',
], { encoding: 'utf8', timeout: 10_000 }));
assert.equal(nodeInfo.version, config.nodeVersion, '随包 Node 版本与 release-config 不一致');
assert.equal(nodeInfo.platform, process.platform, '随包 Node 的操作系统不匹配');
assert.equal(nodeInfo.arch, process.arch, '随包 Node 的 CPU 架构不匹配');

if (!serverOnly) {
  const cubismPath = path.join(desktopRoot, 'public', 'cubism', config.cubismCore.fileName);
  requireRegularFile(cubismPath, 'Cubism Core');
  const hash = sha256File(cubismPath);
  if (!config.cubismCore.allowedSha256.includes(hash)) {
    throw new Error(`Cubism Core SHA-256 未被批准: ${hash}`);
  }
}

verifyCharacterAssets();
const narrativeSqlRoot = path.join(appRoot, 'node_modules', '@ema-agent', 'storage', 'dist', 'migrations', 'narrative');
for (const filename of [
  'narrative.sql',
  'narrative-cache.sql',
  'narrative-seeds-1st.sql',
  'narrative-seeds-2nd.sql',
  'narrative-seeds-3rd.sql',
]) {
  requireRegularFile(path.join(narrativeSqlRoot, filename), `Narrative SQL: ${filename}`);
}

await verifyServerStart();
const scope = serverOnly ? 'Server (未检查 Cubism Core, 不代表安装包检查通过)' : '完整发布资源';
process.stdout.write(`${scope}检查通过: ${target}\n`);

function verifyDesktopVersion() {
  const desktopVersion = readJson(path.join(desktopRoot, 'package.json')).version;
  const tauriVersion = readJson(path.join(tauriRoot, 'tauri.conf.json')).version;
  const cargoPackage = readFileSync(path.join(tauriRoot, 'Cargo.toml'), 'utf8')
    .split(/^\[/mu)
    .find(section => section.startsWith('package]'));
  const cargoVersion = cargoPackage?.match(/^\s*version\s*=\s*"([^"]+)"/mu)?.[1];
  const versions = { desktopVersion, tauriVersion, cargoVersion };
  if (!desktopVersion || !tauriVersion || !cargoVersion || new Set(Object.values(versions)).size !== 1) {
    throw new Error(`Desktop、Tauri 和 Cargo 发布版本不一致: ${JSON.stringify(versions)}`);
  }
}

function verifyCharacterAssets() {
  const modelPath = path.join(characterSource, 'live2d', 'ema', 'ema.model3.json');
  requireRegularFile(modelPath, '艾玛 Live2D 入口');
  const references = readJson(modelPath).FileReferences;
  const files = [references.Moc, ...references.Textures];
  for (const optionalFile of [references.Physics, references.Pose, references.DisplayInfo]) {
    if (optionalFile) {
      files.push(optionalFile);
    }
  }
  for (const expression of references.Expressions ?? []) {
    files.push(expression.File);
  }
  for (const motions of Object.values(references.Motions ?? {})) {
    for (const motion of motions) {
      files.push(motion.File);
    }
  }
  for (const file of files) {
    requireRegularFile(path.resolve(path.dirname(modelPath), file), `Live2D 引用: ${file}`);
  }
  requireRegularFile(path.join(characterSource, 'voice', 'ra_ema001.mp3'), '艾玛参考音频');
}

async function verifyServerStart() {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'ema-release-check-'));
  const profileRoot = path.join(temporaryRoot, 'profile');
  const secret = randomBytes(32).toString('hex');
  try {
    mkdirSync(profileRoot);
    // Rust 首次启动先复制随包角色, 再让 Server 建立内置角色记录. 检查遵守同一顺序.
    cpSync(charactersSource, path.join(profileRoot, 'characters'), { recursive: true });
    const server = spawn(serverBinary, [serverEntry], {
      // 不使用仓库作为 cwd, 让发布目录必须独立找到业务代码和资源.
      cwd: temporaryRoot,
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        EMA_PROFILE_DIR: profileRoot,
        EMA_SHARED_SECRET: secret,
        EMA_INITIALIZE_BUILTIN_CHARACTERS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise(resolve => server.once('close', resolve));
    let output = '';
    const rememberOutput = chunk => {
      output = `${output}${chunk.toString()}`.slice(-8_192);
    };
    server.stdout.on('data', rememberOutput);
    server.stderr.on('data', rememberOutput);
    try {
      const port = await waitForServerReady(server);
      const origin = `http://127.0.0.1:${port}`;
      const readServerJson = async pathname => {
        const response = await fetch(`${origin}${pathname}`, {
          headers: { 'X-Ema-Secret': secret },
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(response.status, 200, `${pathname} 请求失败`);
        return response.json();
      };
      const [health, currentCharacter, sessions, memory] = await Promise.all([
        readServerJson('/health'),
        readServerJson('/api/characters/current'),
        readServerJson('/api/sessions'),
        readServerJson('/api/memory/stats'),
      ]);
      assert.deepEqual(health, { ok: true, service: 'server' });
      assert.equal(currentCharacter.name, '樱羽艾玛', '首次启动没有安装内置角色');
      assert.deepEqual(sessions, { pinned: [], pinnedProjects: [], projects: [], recent: [] });
      assert.equal(memory.rootPath, path.join(profileRoot, 'memories'), 'Memory 没有使用临时应用目录');
      const unauthorized = await fetch(`${origin}/api/characters/current`, {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(unauthorized.status, 401, '业务接口未要求宿主口令');
      await unauthorized.arrayBuffer();
      process.stdout.write('Server 首次启动、角色、空会话、Memory 目录和 HTTP 认证检查通过\n');
    } catch (error) {
      throw new Error(`Server 发布检查失败: ${error.message}\n${output}`, { cause: error });
    } finally {
      const forceStop = setTimeout(() => server.kill('SIGKILL'), 5_000);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGTERM');
      }
      await closed;
      clearTimeout(forceStop);
    }

    requireRegularFile(path.join(profileRoot, 'profile.db'), '首次启动 profile.db');
    requireRegularFile(path.join(profileRoot, 'data', 'data.db'), '首次启动 data.db');
    // 使用发布目录自己的原生依赖读取刚初始化的库, 并实际生成一张图片.
    execFileSync(serverBinary, [
      '--input-type=module', '--eval', `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.argv[1], 'package.json'));
const storageRequire = createRequire(require.resolve('@ema-agent/storage'));
const Database = storageRequire('better-sqlite3');
const sharp = require('sharp');
const db = new Database(path.join(process.argv[2], 'narrative', 'narrative.db'), { readonly: true });
try {
  for (const table of ['chunks', 'entities', 'relations']) {
    const rows = db.prepare('SELECT timeline_id, COUNT(*) AS count FROM ' + table + ' GROUP BY timeline_id').all();
    assert.deepEqual(rows.map(row => row.timeline_id).sort(), ['1st_Loop', '2nd_Loop', '3rd_Loop']);
    assert.ok(rows.every(row => row.count > 0), table + ' 缺少剧情数据');
    process.stdout.write(table + ': ' + JSON.stringify(rows) + '\\n');
  }
} finally {
  db.close();
}
await sharp({ create: { width: 1, height: 1, channels: 4, background: '#000000' } }).png().toBuffer();
process.stdout.write('SQLite、Sharp 和三周目剧情初始化检查通过\\n');
`, appRoot, profileRoot,
    ], { cwd: temporaryRoot, stdio: 'inherit', timeout: 30_000 });
  } finally {
    if (path.dirname(temporaryRoot) !== path.resolve(os.tmpdir())) {
      throw new Error(`临时目录超出系统临时目录: ${temporaryRoot}`);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function waitForServerReady(server) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: server.stdout });
    const timer = setTimeout(() => fail(new Error('Server 在 30 秒内没有报告就绪端口')), 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      lines.close();
      server.off('error', fail);
      server.off('exit', onExit);
    };
    const fail = error => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      fail(new Error(`Server 在就绪前退出: code=${code}, signal=${signal}`));
    };
    server.once('error', fail);
    server.once('exit', onExit);
    lines.on('line', line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.jsonrpc !== '2.0' || message.method !== 'server.ready') {
        return;
      }
      const port = message.params?.port;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        fail(new Error('server.ready 中没有有效端口'));
        return;
      }
      cleanup();
      resolve(port);
    });
  });
}
