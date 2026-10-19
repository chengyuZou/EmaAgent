import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { copyReleaseWorkspace, assembleReleaseApp } from './releaseWorkspace.mjs';
import { checkReleaseFiles, checkReleaseServer, checkReleaseVersions } from './releaseCheck.mjs';

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
  throw new Error('请从仓库根目录运行 pnpm release');
}
if (process.versions.node !== config.nodeVersion) {
  throw new Error(`发布需要 Node ${config.nodeVersion}, 当前为 ${process.versions.node}`);
}
const host = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' }).match(/^host: (.+)$/mu)?.[1].trim();
const target = args.target ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? host;
if (!host || target !== host) {
  throw new Error(`原生依赖必须在目标平台构建: target=${target}, host=${host}`);
}
verifyAssets(!args['server-only']);
const temporary = mkdtempSync(path.join(os.tmpdir(), 'ema-release-'));
const workspace = path.join(temporary, 'workspace');
const portable = path.join(temporary, 'portable');
const app = path.join(portable, 'app');
const suffix = process.platform === 'win32' ? '.exe' : '';
const node = path.join(portable, `ema-server${suffix}`);
try {
  stage('构建当前 Server 及其工作区依赖', () => runPnpm(['--filter', '@ema-agent/server...', 'build'], repository));
  stage('在独立目录安装锁定的生产依赖', () => {
    copyReleaseWorkspace(repository, workspace);
    const store = runPnpm(['store', 'path', '--silent'], repository, true).trim();
    runPnpm(['install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted', '--store-dir', store], workspace);
  });
  stage('生成不含符号链接的发布目录', () => {
    assembleReleaseApp(workspace, app);
    copyFileSync(process.execPath, node);
    chmodSync(node, 0o755);
    const result = checkReleaseFiles(app);
    console.log(`发布文件 ${result.files} 个, 最长源路径 ${result.longest.length} 字符`);
  });
  // 删除安装工作区后再启动, 防止检查时误用工作区中的链接或依赖.
  rmSync(workspace, { recursive: true, force: true });
  console.log('\n[发布] 验证独立运行和原生依赖');
  await checkReleaseServer(app, node, resources, temporary, config.nodeVersion);
  stage('交付已验证的 Server 资源', () => writeServerResources(app, node, target));
  if (args['server-only']) {
    console.log('Server 发布资源检查通过; 尚未生成或验收桌面安装包');
  } else {
    const bundles = args.bundles ?? ({ win32: 'nsis', darwin: 'dmg', linux: 'deb' }[process.platform]);
    stage('构建桌面和安装包', () => runPnpm([
      'exec', 'tauri', 'build', '--config', 'src-tauri/tauri.release.conf.json',
      ...(args.target ? ['--target', target] : []), '--bundles', bundles,
    ], desktop));
    const buildTarget = args.target ? path.join(tauri, 'target', target) : path.join(tauri, 'target');
    console.log(`\n安装包输出: ${path.join(buildTarget, 'release', 'bundle')}`);
    console.log('安装包已生成; 尚未在真实用户目录安装和验收桌面交互');
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
  console.log(`\n[发布] ${label}`);
  action();
  console.log(`[发布] ${label}完成 (${((performance.now() - start) / 1000).toFixed(1)} 秒)`);
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
      throw new Error(`Live2D 资源不是文件: ${file}`);
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
    throw new Error(`Cubism Core SHA-256 未被批准: ${hash}`);
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
    throw new Error('Windows 安装包需要 .ico 图标');
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
