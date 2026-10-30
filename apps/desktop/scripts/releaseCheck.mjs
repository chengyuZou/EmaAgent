import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function checkReleaseVersions(repository) {
  const manifests = [
    'package.json',
    'apps/desktop/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
  ];
  const versions = manifests.map(file => ({
    file,
    version: JSON.parse(readFileSync(path.join(repository, file), 'utf8')).version,
  }));
  const cargoFile = 'apps/desktop/src-tauri/Cargo.toml';
  const cargo = readFileSync(path.join(repository, cargoFile), 'utf8');
  const section = cargo.split(/^\[/mu).find(value => value.startsWith('package]'));
  versions.push({
    file: cargoFile,
    version: section?.match(/^version\s*=\s*"([^"]+)"/mu)?.[1],
  });
  const rootVersion = versions[0].version;
  if (typeof rootVersion !== 'string' || rootVersion.trim().length === 0
    || versions.some(entry => entry.version !== rootVersion)) {
    const details = versions
      .map(entry => `${entry.file}: ${JSON.stringify(entry.version) ?? '(missing)'}`)
      .join('\n');
    throw new Error(`Release versions must be nonempty and match the root package.json. Update these files manually:\n${details}`);
  }
}

export function checkReleaseFiles(directory, windowsPaths = process.platform === 'win32') {
  let files = 0;
  let longest = '';
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Release resources must not depend on symbolic links: ${absolute}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        if (windowsPaths && absolute.length >= 260) {
          throw new Error(`Installer tools cannot read paths longer than 259 characters (${absolute.length}): ${absolute}`);
        }
        files++;
        if (absolute.length > longest.length) {
          longest = absolute;
        }
      }
    }
  }
  visit(directory);
  return { files, longest };
}

export async function checkReleaseServer(appRoot, nodeBinary, resources, temporaryRoot, nodeVersion) {
  const profileRoot = path.join(temporaryRoot, 'profile');
  mkdirSync(profileRoot);
  // 与桌面首次启动顺序相同: 先复制资源, 再初始化数据库.
  cpSync(path.join(resources, 'characters'), path.join(profileRoot, 'characters'), { recursive: true });
  mkdirSync(path.join(profileRoot, 'profile'));
  cpSync(path.join(resources, 'models-dev.json'), path.join(profileRoot, 'profile', 'models-dev.json'));
  const secret = randomBytes(32).toString('hex');
  const environment = { ...process.env };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  // 与 Rust 的 server_launch 一致, 主脚本相对 server/app 启动.
  const server = spawn(nodeBinary, ['./dist/main.js'], {
    cwd: appRoot,
    windowsHide: true,
    env: {
      ...environment,
      NODE_ENV: 'production',
      EMA_PROFILE_DIR: profileRoot,
      EMA_SHARED_SECRET: secret,
      EMA_INITIALIZE_BUILTIN_CHARACTERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => server.once('close', resolve));
  let output = '';
  const remember = chunk => {
    output = `${output}${chunk.toString()}`.slice(-16_384);
  };
  server.stdout.on('data', remember);
  server.stderr.on('data', remember);
  try {
    const port = await waitForServerReady(server);
    const origin = `http://127.0.0.1:${port}`;
    async function readJson(route) {
      const response = await fetch(`${origin}${route}`, {
        headers: { 'X-Ema-Secret': secret }, signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200, `HTTP request failed: ${route}`);
      return response.json();
    }
    const [health, character, sessions, memory] = await Promise.all([
      readJson('/health'), readJson('/api/characters/current'),
      readJson('/api/sessions'), readJson('/api/memory/stats'),
    ]);
    assert.deepEqual(health, { ok: true, service: 'server' });
    assert.equal(character.name, '樱羽艾玛');
    assert.deepEqual(sessions, { pinned: [], pinnedProjects: [], projects: [], recent: [] });
    assert.equal(memory.rootPath, path.join(profileRoot, 'memories'));
    const unauthorized = await fetch(`${origin}/api/characters/current`, { signal: AbortSignal.timeout(10_000) });
    await unauthorized.arrayBuffer();
    assert.equal(unauthorized.status, 401);
    console.log('Standalone checks passed outside the build workspace: Server, characters, empty sessions, Memory paths, and HTTP authentication.');
  } catch (error) {
    throw new Error(`Release Server check failed: ${error.message}\n${output}`, { cause: error });
  } finally {
    const timer = setTimeout(() => server.kill('SIGKILL'), 5_000);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
    }
    await closed;
    clearTimeout(timer);
  }
  assert.ok(statSync(path.join(profileRoot, 'profile.db')).size > 0);
  assert.ok(statSync(path.join(profileRoot, 'data', 'data.db')).size > 0);
  const nativeCheck = fileURLToPath(new URL('./releaseNativeCheck.mjs', import.meta.url));
  execFileSync(nodeBinary, [nativeCheck, appRoot, profileRoot, nodeVersion], {
    cwd: temporaryRoot, env: environment, stdio: 'inherit', windowsHide: true, timeout: 30_000,
  });
}

export function waitForServerReady(server, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: server.stdout });
    const timer = setTimeout(() => fail(new Error(`Server did not report a ready port within ${timeoutMs / 1000} seconds.`)), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      lines.close();
      server.off('error', fail);
      server.off('exit', onExit);
    }
    function fail(error) {
      cleanup();
      reject(error);
    }
    function onExit(code, signal) {
      fail(new Error(`Server exited before reporting readiness: code=${code}, signal=${signal}`));
    }
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
        fail(new Error('Invalid port in server.ready.'));
        return;
      }
      cleanup();
      resolve(port);
    });
  });
}
