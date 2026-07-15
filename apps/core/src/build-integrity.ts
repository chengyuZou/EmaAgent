import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface CoreBuildManifest {
  schemaVersion:     1;
  packageName:       '@ema-agent/core';
  packageVersion:    string;
  sourceFingerprint: string;
  files:             Record<string, string>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function parseManifest(raw: string): CoreBuildManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('Core 生产构建清单不是有效 JSON', { cause: error });
  }

  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('schemaVersion' in value) || value.schemaVersion !== 1 ||
    !('packageName' in value) || value.packageName !== '@ema-agent/core' ||
    !('packageVersion' in value) || typeof value.packageVersion !== 'string' ||
    !('sourceFingerprint' in value) || typeof value.sourceFingerprint !== 'string' ||
    !('files' in value) || !isStringRecord(value.files)
  ) {
    throw new Error('Core 生产构建清单结构无效');
  }

  return value as CoreBuildManifest;
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join('/');
}

function listFiles(root: string): string[] {
  const files: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Core 生产构建目录包含符号链接: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = normalizeRelative(path.relative(root, absolutePath));
        if (relativePath !== 'build-manifest.json') files.push(relativePath);
      }
    }
  };

  visit(root);
  return files.sort();
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sourceFingerprint(sourceDir: string): string {
  const fingerprint = createHash('sha256');
  for (const relativePath of listFiles(sourceDir)) {
    fingerprint.update(relativePath);
    fingerprint.update('\0');
    fingerprint.update(readFileSync(path.join(sourceDir, ...relativePath.split('/'))));
    fingerprint.update('\0');
  }
  return fingerprint.digest('hex');
}

/**
 * 开发态由 tsx 直接执行 src/index.ts，不要求存在构建清单。
 * 任何编译后的 JavaScript 入口都必须携带并通过本次构建生成的完整性清单。
 */
export function verifyCoreBuildIntegrity(entryModuleUrl: string): void {
  const entryPath = fileURLToPath(entryModuleUrl);
  if (path.extname(entryPath) === '.ts') return;

  const distDir = path.dirname(entryPath);
  const manifestPath = path.join(distDir, 'build-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Core 生产构建缺少 build-manifest.json: ${distDir}`);
  }

  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  const sourceDir = path.resolve(distDir, '..', 'src');
  if (
    existsSync(sourceDir) &&
    sourceFingerprint(sourceDir) !== manifest.sourceFingerprint
  ) {
    throw new Error('Core 源码与生产构建指纹不一致，请重新执行 clean build');
  }

  const expectedFiles = Object.keys(manifest.files).sort();
  const actualFiles = listFiles(distDir);
  const missingFiles = expectedFiles.filter((file) => !actualFiles.includes(file));
  const unexpectedFiles = actualFiles.filter((file) => !expectedFiles.includes(file));

  if (missingFiles.length > 0 || unexpectedFiles.length > 0) {
    const details = [
      missingFiles.length > 0 ? `缺失: ${missingFiles.join(', ')}` : '',
      unexpectedFiles.length > 0 ? `多余: ${unexpectedFiles.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`Core 生产构建文件清单不一致。${details}`);
  }

  for (const relativePath of expectedFiles) {
    const expectedHash = manifest.files[relativePath];
    if (!expectedHash) {
      throw new Error(`Core 生产构建清单缺少文件摘要: ${relativePath}`);
    }
    const absolutePath = path.join(distDir, ...relativePath.split('/'));
    const actualHash = sha256File(absolutePath);
    if (actualHash !== expectedHash) {
      throw new Error(`Core 生产构建文件摘要不匹配: ${relativePath}`);
    }
  }
}
