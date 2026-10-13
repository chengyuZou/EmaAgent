// Server 使用 Node 执行发布目录里的 JS; ema-server 是随安装包携带的 Node 可执行文件.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  executableSuffix,
  parseTargetArgument,
  readJson,
  requireRegularFile,
  rustHostTarget,
} from './release-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const workspaceRoot = path.resolve(desktopRoot, '..', '..');
const serverPackageRoot = path.join(workspaceRoot, 'apps', 'server');
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
const previousServer = `${serverResourceRoot}.previous-${process.pid}`;
const temporaryBinary = `${binaryPath}.tmp-${process.pid}`;

// 只清理本脚本在 src-tauri 下生成的确切目录, 不把任意命令行路径用于删除.
for (const output of [stagingRoot, serverResourceRoot, previousServer, temporaryBinary]) {
  const relative = path.relative(tauriRoot, output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`发布输出超出 src-tauri: ${output}`);
  }
}

const pnpmScript = process.env['npm_execpath'];
if (!pnpmScript) {
  throw new Error('请通过 pnpm release:prepare:server 运行此脚本');
}
requireRegularFile(pnpmScript, 'pnpm 入口');

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });
try {
  // JS 版使用当前 Node, Windows 的独立 exe 版直接运行; 两者都不经过 Shell.
  runPnpm(['--filter', '@ema-agent/server...', 'build'], workspaceRoot);
  // pnpm 9 的 deploy 要使用所选包的 cwd, 并从这个目录计算相对目标路径.
  runPnpm([
    '--filter', '@ema-agent/server',
    'deploy', '--prod', path.relative(serverPackageRoot, stagingApp),
  ], serverPackageRoot);

  requireRegularFile(path.join(stagingApp, 'dist', 'main.js'), 'Server 入口');
  prepareDependencyLinks(stagingApp);

  mkdirSync(path.dirname(binaryPath), { recursive: true });
  copyFileSync(process.execPath, temporaryBinary);
  if (!target.includes('windows')) {
    chmodSync(temporaryBinary, 0o755);
  }
  installServerDirectory();
  rmSync(binaryPath, { force: true });
  renameSync(temporaryBinary, binaryPath);
  process.stdout.write(`Server 发布目录已准备: ${target}\n`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
  rmSync(temporaryBinary, { force: true });
}

function runPnpm(args, cwd) {
  if (pnpmScript.endsWith('.exe')) {
    execFileSync(pnpmScript, args, { cwd, stdio: 'inherit' });
  } else {
    execFileSync(process.execPath, [pnpmScript, ...args], { cwd, stdio: 'inherit' });
  }
}

function prepareDependencyLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = realpathSync(absolute);
      const selfAlias = path.join(stagingApp, 'node_modules', '.pnpm', 'node_modules', '@ema-agent', 'server');
      // pnpm 9 还生成一个指回源码 Server 的自身别名. 包自身引用由 app/package.json 解析,
      // 不需要这个别名; 留下它会依赖开发仓库, 指回 app 则会造成目录循环.
      if (absolute === selfAlias && resolved === realpathSync(serverPackageRoot)) {
        unlinkSync(absolute);
        continue;
      }
      const relative = path.relative(stagingApp, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Server 依赖仍指向发布目录外: ${absolute}`);
      }
      // Windows junction 保存绝对路径, 移动发布目录后就会失效. 使用相对符号链接,
      // 并在打包机上要求创建链接的权限; 正式用户只消费已经打包好的资源.
      if (process.platform === 'win32' || path.isAbsolute(readlinkSync(absolute))) {
        const type = statSync(absolute).isDirectory() ? 'dir' : 'file';
        const relativeTarget = path.relative(path.dirname(absolute), resolved);
        unlinkSync(absolute);
        try {
          symlinkSync(relativeTarget, absolute, type);
        } catch (error) {
          throw new Error('发布依赖需要创建相对符号链接; Windows 请启用开发者模式或以管理员身份构建', {
            cause: error,
          });
        }
      }
    } else if (entry.isDirectory()) {
      prepareDependencyLinks(absolute);
    }
  }
}

function installServerDirectory() {
  rmSync(previousServer, { recursive: true, force: true });
  mkdirSync(path.dirname(serverResourceRoot), { recursive: true });
  if (existsSync(serverResourceRoot)) {
    renameSync(serverResourceRoot, previousServer);
  }
  try {
    renameSync(stagingRoot, serverResourceRoot);
  } catch (error) {
    if (existsSync(previousServer)) {
      renameSync(previousServer, serverResourceRoot);
    }
    throw error;
  }
  rmSync(previousServer, { recursive: true, force: true });
}
