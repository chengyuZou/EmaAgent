import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
const srcDir = path.join(appRoot, 'src');
const distDir = path.join(appRoot, 'dist');
const packageJsonPath = path.join(appRoot, 'package.json');
const snapshotPath = path.join(appRoot, 'models-dev-snapshot.json');

function normalizeRelative(value) {
  return value.split(path.sep).join('/');
}

function listFiles(root) {
  const files = [];

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`构建目录不允许符号链接: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(normalizeRelative(path.relative(root, absolutePath)));
      }
    }
  };

  visit(root);
  return files.sort();
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sourceOutputs(relativeSourcePath) {
  if (!relativeSourcePath.endsWith('.ts')) {
    throw new Error(`Core src 中出现非 TypeScript 文件: ${relativeSourcePath}`);
  }

  const stem = relativeSourcePath.slice(0, -3);
  return [
    `${stem}.js`,
    `${stem}.js.map`,
    `${stem}.d.ts`,
    `${stem}.d.ts.map`,
  ];
}

if (!existsSync(srcDir) || !existsSync(distDir)) {
  throw new Error('Core 构建收尾失败:src 或 dist 目录不存在');
}
if (!existsSync(snapshotPath)) {
  throw new Error('Core 构建收尾失败:models-dev-snapshot.json 不存在');
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
if (packageJson.name !== '@ema-agent/core' || typeof packageJson.version !== 'string') {
  throw new Error('Core package.json 的 name/version 契约无效');
}

copyFileSync(snapshotPath, path.join(distDir, 'models-dev-snapshot.json'));

const sourceFiles = listFiles(srcDir);
const expectedFiles = new Set([
  ...sourceFiles.flatMap(sourceOutputs),
  'models-dev-snapshot.json',
]);
const actualFiles = listFiles(distDir);
const missingFiles = [...expectedFiles].filter((file) => !actualFiles.includes(file)).sort();
const unexpectedFiles = actualFiles.filter((file) => !expectedFiles.has(file)).sort();

if (missingFiles.length > 0 || unexpectedFiles.length > 0) {
  const details = [
    missingFiles.length > 0 ? `缺失: ${missingFiles.join(', ')}` : '',
    unexpectedFiles.length > 0 ? `多余: ${unexpectedFiles.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  throw new Error(`Core src/dist 清单不一致。${details}`);
}

const files = Object.fromEntries(
  actualFiles.map((relativePath) => [
    relativePath,
    sha256File(path.join(distDir, ...relativePath.split('/'))),
  ]),
);
const sourceFingerprint = createHash('sha256');
for (const relativePath of sourceFiles) {
  sourceFingerprint.update(relativePath);
  sourceFingerprint.update('\0');
  sourceFingerprint.update(readFileSync(path.join(srcDir, ...relativePath.split('/'))));
  sourceFingerprint.update('\0');
}

const manifest = {
  schemaVersion: 1,
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  sourceFingerprint: sourceFingerprint.digest('hex'),
  files,
};

writeFileSync(
  path.join(distDir, 'build-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

const totalBytes = actualFiles.reduce(
  (sum, relativePath) => sum + statSync(path.join(distDir, ...relativePath.split('/'))).size,
  0,
);
console.log(`[core:build] 已验证 ${sourceFiles.length} 个源码、${actualFiles.length} 个产物，共 ${totalBytes} bytes`);
