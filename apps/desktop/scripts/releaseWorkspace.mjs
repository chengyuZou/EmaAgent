import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

// 在独立目录安装生产依赖, 避免 pnpm 的 hoisted 布局改动开发仓库.
export function copyReleaseWorkspace(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches']) {
    cpSync(path.join(source, file), path.join(destination, file), { recursive: true });
  }
  const packageDirectories = new Map();
  for (const entry of readdirSync(path.join(source, 'src'), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const directory = `src/${entry.name}`;
      const manifest = JSON.parse(readFileSync(path.join(source, directory, 'package.json'), 'utf8'));
      packageDirectories.set(manifest.name, directory);
    }
  }
  const packages = new Set(['apps/server']);
  for (const directory of packages) {
    const packageRoot = path.join(source, directory);
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (version.startsWith('workspace:')) {
        const dependency = packageDirectories.get(name);
        if (!dependency) {
          throw new Error(`Release dependencies are missing a workspace package: ${name}`);
        }
        packages.add(dependency);
      }
    }
    const output = path.join(destination, directory);
    mkdirSync(output, { recursive: true });
    for (const file of ['package.json', ...manifest.files]) {
      cpSync(path.join(packageRoot, file), path.join(output, file), { recursive: true });
    }
  }
}

// 工作区包都只有一个版本, 放到同一个 @ema-agent 目录后由 Node 正常解析.
// 外部依赖的嵌套 node_modules 原样保留, 不改变 pnpm 选出的版本.
export function assembleReleaseApp(workspace, destination) {
  const workspacePackages = new Set();
  for (const entry of readdirSync(path.join(workspace, 'src'), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      workspacePackages.add(realpathSync(path.join(workspace, 'src', entry.name)));
    }
  }
  const copy = (source, target) => {
    cpSync(source, target, {
      recursive: true,
      filter: file => {
        if (['.bin', '.pnpm', '.modules.yaml'].includes(path.basename(file))) {
          return false;
        }
        if (!lstatSync(file).isSymbolicLink()) {
          return true;
        }
        if (workspacePackages.has(realpathSync(file))) {
          return false;
        }
        throw new Error(`Release dependencies contain an unhandled symbolic link: ${file}`);
      },
    });
  };
  copy(path.join(workspace, 'node_modules'), path.join(destination, 'node_modules'));
  const server = path.join(workspace, 'apps', 'server');
  copy(server, destination);
  for (const packageRoot of workspacePackages) {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const target = path.join(destination, 'node_modules', manifest.name);
    if (existsSync(path.join(target, 'package.json'))) {
      throw new Error(`Release dependencies contain a duplicate workspace package: ${manifest.name}`);
    }
    copy(packageRoot, target);
  }
}
