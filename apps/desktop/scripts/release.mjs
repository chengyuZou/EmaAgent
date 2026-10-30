import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { copyReleaseWorkspace, assembleReleaseApp } from './releaseWorkspace.mjs';
import { checkReleaseFiles, checkReleaseServer, checkReleaseVersions } from './releaseCheck.mjs';
import { buildComputerUse } from './buildComputerUse.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(desktop, '../..');
const tauri = path.join(desktop, 'src-tauri');
const resources = path.join(tauri, 'resources');
const config = readJson(path.join(desktop, 'release-config.json'));
const { values: args } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== '--'),
  options: {
    target: { type: 'string' },
    bundles: { type: 'string' },
    'server-only': { type: 'boolean', default: false },
    'cubism-core': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});
if (args.help) {
  console.log('pnpm release [--bundles nsis|msi|dmg|app|deb|rpm|appimage] [--target <host>] [--cubism-core <file>] [--server-only]');
  process.exit(0);
}
checkReleaseVersions(repository);
const pnpm = process.env.npm_execpath;
if (!pnpm) {
  throw new Error('Run pnpm release from the repository root.');
}
if (process.versions.node !== config.nodeVersion) {
  throw new Error(`Release builds require Node ${config.nodeVersion}; current version: ${process.versions.node}.`);
}
const host = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' }).match(/^host: (.+)$/mu)?.[1].trim();
const target = args.target ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? host;
if (!host || target !== host) {
  throw new Error(`Native dependencies must be built on the target platform: target=${target}, host=${host}`);
}
verifyAssets(!args['server-only']);
const temporary = mkdtempSync(path.join(os.tmpdir(), 'ema-release-'));
const workspace = path.join(temporary, 'workspace');
const portable = path.join(temporary, 'portable');
const app = path.join(portable, 'app');
const suffix = process.platform === 'win32' ? '.exe' : '';
const node = path.join(portable, `ema-server${suffix}`);
try {
  stage('Build the Windows computer-use helper', () => buildComputerUse({ release: true }));
  stage('Build Server and its workspace dependencies', () => runPnpm([
    '--workspace-concurrency=4', '--filter', '@ema-agent/server...', 'build',
  ], repository));
  stage('Install locked production dependencies in an isolated workspace', () => {
    copyReleaseWorkspace(repository, workspace);
    const store = runPnpm(['store', 'path', '--silent'], repository, true).trim();
    runPnpm(['install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted', '--store-dir', store], workspace);
  });
  stage('Assemble the release directory without symbolic links', () => {
    assembleReleaseApp(workspace, app);
    copyFileSync(process.execPath, node);
    chmodSync(node, 0o755);
    const result = checkReleaseFiles(app);
    console.log(`Release files: ${result.files}; longest source path: ${result.longest.length} characters`);
  });
  // 删除安装工作区后再启动, 防止检查时误用工作区中的链接或依赖.
  rmSync(workspace, { recursive: true, force: true });
  console.log('\n[Release] Verify standalone startup and native dependencies');
  await checkReleaseServer(app, node, resources, temporary, config.nodeVersion);
  stage('Copy verified Server resources', () => writeServerResources(app, node, target));
  if (args['server-only']) {
    console.log('Server release resources passed validation; the desktop installer has not been built or tested.');
  } else {
    const bundles = args.bundles ?? ({ win32: 'nsis', darwin: 'dmg', linux: 'deb' }[process.platform]);
    stage('Build the desktop application and installer', () => runPnpm([
      'exec', 'tauri', 'build', '--config', 'src-tauri/tauri.release.conf.json',
      ...(args.target ? ['--target', target] : []), '--bundles', bundles,
    ], desktop));
    const buildTarget = args.target ? path.join(tauri, 'target', target) : path.join(tauri, 'target');
    console.log(`\nInstaller output: ${path.join(buildTarget, 'release', 'bundle')}`);
    console.log('Installer generated; installation in a real user directory and desktop interaction checks are still required.');
  }
} finally {
  // temporary 由本次 mkdtemp 创建, 不接受命令行提供的删除目录.
  rmSync(temporary, { recursive: true, force: true });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function runPnpm(arguments_, cwd, capture = false) {
  const executable = pnpm.endsWith('.exe') ? pnpm : process.execPath;
  const command = pnpm.endsWith('.exe') ? arguments_ : [pnpm, ...arguments_];
  return execFileSync(executable, command, {
    cwd, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', windowsHide: true,
  });
}

function stage(label, action) {
  const start = performance.now();
  console.log(`\n[Release] ${label}`);
  action();
  console.log(`[Release] Completed: ${label} (${((performance.now() - start) / 1000).toFixed(1)} s)`);
}

function verifyAssets(includeDesktop) {
  const model = path.join(resources, 'characters', '樱羽艾玛', 'live2d', 'ema', 'ema.model3.json');
  const references = readJson(model).FileReferences;
  const files = [references.Moc, ...references.Textures];
  for (const file of [references.Physics, references.Pose, references.DisplayInfo]) {
    if (file) {
      files.push(file);
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
    if (!statSync(path.resolve(path.dirname(model), file)).isFile()) {
      throw new Error(`Live2D resource is not a file: ${file}`);
    }
  }
  statSync(path.join(resources, 'characters', '樱羽艾玛', 'voice', 'ra_ema001.mp3'));
  readJson(path.join(resources, 'models-dev.json'));
  if (!includeDesktop) {
    return;
  }
  const destination = path.join(desktop, 'public', 'cubism', config.cubismCore.fileName);
  const source = path.resolve(args['cubism-core'] ?? process.env.EMA_CUBISM_CORE_PATH ?? destination);
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (!config.cubismCore.allowedSha256.includes(hash)) {
    throw new Error(`Cubism Core SHA-256 is not approved: ${hash}`);
  }
  if (source !== destination) {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  const icons = readJson(path.join(tauri, 'tauri.conf.json')).bundle.icon;
  for (const icon of icons) {
    statSync(path.join(tauri, icon));
  }
  if (process.platform === 'win32' && !icons.some(icon => icon.endsWith('.ico'))) {
    throw new Error('Windows installers require an .ico icon.');
  }
}

function writeServerResources(appRoot, nodeBinary, target) {
  const staging = path.join(tauri, '.release-staging');
  const output = path.join(staging, 'server');
  const binary = path.join(tauri, 'binaries', `ema-server-${target}${suffix}`);
  // 这里只删除固定的生成目录, 不接收外部指定的清理路径.
  // 任何复制或检查失败都会中断发布, Tauri 不会消费半成品.
  rmSync(output, { recursive: true, force: true });
  cpSync(appRoot, path.join(output, 'app'), { recursive: true });
  checkReleaseFiles(output);
  mkdirSync(path.dirname(binary), { recursive: true });
  copyFileSync(nodeBinary, binary);
  chmodSync(binary, 0o755);
}
