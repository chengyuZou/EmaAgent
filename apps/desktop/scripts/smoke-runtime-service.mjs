// 启动真实 Core 或 Bridge 制品，验证 readiness 身份、健康端点与可靠退出。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && !value) throw new Error(`缺少 ${name}`);
  return value;
}

const service = argument('--service');
const executable = path.resolve(argument('--executable'));
const entry = argument('--entry', false);
const narrativeSeed = argument('--narrative', false);
if (service !== 'core' && service !== 'bridge') {
  throw new Error(`未知运行时服务: ${service}`);
}
if (service === 'core' && !entry) throw new Error('Core smoke 缺少 --entry');
if (service === 'bridge' && !narrativeSeed) throw new Error('Bridge smoke 缺少 --narrative');

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), `ema-${service}-smoke-`));
const readyFile = path.join(temporaryRoot, `${service}.ready.json`);
const nonce = randomBytes(16).toString('hex');
const sharedSecret = randomBytes(32).toString('hex');
const credentialKey = randomBytes(32).toString('hex');
const output = [];
let child;

try {
  let narrativeDirectory;
  if (narrativeSeed) {
    narrativeDirectory = path.join(temporaryRoot, 'narrative');
    cpSync(path.resolve(narrativeSeed), narrativeDirectory, { recursive: true });
  }

  const environment = {
    ...process.env,
    HOME: temporaryRoot,
    USERPROFILE: temporaryRoot,
    EMA_PROFILE_DIR: path.join(temporaryRoot, 'profile'),
    EMA_DATA_DIR: path.join(temporaryRoot, 'bridge-data'),
    EMA_SHARED_SECRET: sharedSecret,
    EMA_CREDENTIAL_MASTER_KEY: credentialKey,
    EMA_READY_FILE: readyFile,
    EMA_RUNTIME_NONCE: nonce,
    EMA_RUNTIME_PROTOCOL_VERSION: '1',
  };
  if (narrativeDirectory) environment.EMA_NARRATIVE_DIR = narrativeDirectory;

  child = spawn(executable, entry ? [path.resolve(entry)] : [], {
    cwd: entry ? path.dirname(path.dirname(path.resolve(entry))) : path.dirname(executable),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output.push(chunk);
      if (output.join('').length > 64 * 1024) output.shift();
    });
  }

  const deadline = Date.now() + (service === 'bridge' ? 120_000 : 60_000);
  let ready;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${service} 在 readiness 前退出 (${child.exitCode})\n${output.join('')}`);
    }
    if (existsSync(readyFile)) {
      ready = JSON.parse(readFileSync(readyFile, 'utf8'));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`${service} readiness 超时\n${output.join('')}`);
  if (
    ready.service !== service
    || ready.pid !== child.pid
    || ready.nonce !== nonce
    || ready.protocolVersion !== 1
    || !Number.isInteger(ready.port)
  ) {
    throw new Error(`${service} readiness 身份不匹配: ${JSON.stringify(ready)}`);
  }

  const response = await fetch(`http://127.0.0.1:${ready.port}/health`);
  if (!response.ok) throw new Error(`${service} health 返回 ${response.status}`);
  process.stdout.write(`${service} packaged readiness/health smoke ready\n`);
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
