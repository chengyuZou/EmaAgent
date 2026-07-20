// 从开发 Narrative 世界构建只读发布种子，并排除可再生的供应商响应缓存。
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  listRegularFiles,
  readJson,
  replaceDirectoryAtomically,
  sha256File,
} from './release-utils.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const workspaceRoot = path.resolve(desktopRoot, '..', '..');
const sourceRoot = path.join(workspaceRoot, 'apps', 'bridge', 'data', 'narrative');
const destinationRoot = path.join(desktopRoot, 'src-tauri', 'resources', 'narrative-seed');
const stagingRoot = `${destinationRoot}.staging-${process.pid}`;
const config = readJson(path.join(desktopRoot, 'release-config.json'));
const excluded = new Set(config.narrativeSeed.excludedFileNames);
const requiredTimelines = ['1st_Loop', '2nd_Loop', '3rd_Loop'];

for (const timeline of requiredTimelines) {
  const timelinePath = path.join(sourceRoot, timeline);
  if (!statSync(timelinePath).isDirectory()) {
    throw new Error(`Narrative seed 缺少时间线: ${timelinePath}`);
  }
}

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

const sourceFiles = listRegularFiles(sourceRoot);
const includedFiles = sourceFiles.filter((relativePath) => !excluded.has(path.posix.basename(relativePath)));
for (const relativePath of includedFiles) {
  const source = path.join(sourceRoot, ...relativePath.split('/'));
  const destination = path.join(stagingRoot, ...relativePath.split('/'));
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

const files = Object.fromEntries(
  includedFiles.map((relativePath) => [
    relativePath,
    {
      size: statSync(path.join(stagingRoot, ...relativePath.split('/'))).size,
      sha256: sha256File(path.join(stagingRoot, ...relativePath.split('/'))),
    },
  ]),
);
const manifest = {
  schemaVersion: 1,
  contentVersion: config.narrativeSeed.contentVersion,
  excludedFileNames: [...excluded].sort(),
  files,
};
writeFileSync(
  path.join(stagingRoot, 'release-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

replaceDirectoryAtomically(stagingRoot, destinationRoot);
const totalBytes = Object.values(files).reduce((sum, item) => sum + item.size, 0);
process.stdout.write(
  `Narrative seed prepared: ${includedFiles.length} files, ${totalBytes} bytes, excluded ${sourceFiles.length - includedFiles.length}\n`,
);
