import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyCoreBuildIntegrity } from '../src/build-integrity.js';

const temporaryDirectories: string[] = [];

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sourceFingerprint(relativePath: string, filePath: string): string {
  return createHash('sha256')
    .update(relativePath)
    .update('\0')
    .update(readFileSync(filePath))
    .update('\0')
    .digest('hex');
}

function createValidBuild(): {
  root: string;
  entryPath: string;
  manifestPath: string;
  sourcePath: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'ema-core-build-'));
  temporaryDirectories.push(root);

  const sourceDir = path.join(root, 'src');
  const distDir = path.join(root, 'dist');
  const sourcePath = path.join(sourceDir, 'index.ts');
  const entryPath = path.join(distDir, 'index.js');
  const manifestPath = path.join(distDir, 'build-manifest.json');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(sourcePath, 'export const ready = true;\n', 'utf8');
  writeFileSync(entryPath, 'export const ready = true;\n', 'utf8');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      packageName: '@ema-agent/core',
      packageVersion: '0.1.0',
      sourceFingerprint: sourceFingerprint('index.ts', sourcePath),
      files: { 'index.js': sha256(entryPath) },
    }),
    'utf8',
  );
  return { root, entryPath, manifestPath, sourcePath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('verifyCoreBuildIntegrity', () => {
  it('开发态 TypeScript 入口不要求构建清单', () => {
    expect(() => verifyCoreBuildIntegrity(pathToFileURL('src/index.ts').href)).not.toThrow();
  });

  it('接受文件清单与摘要完全一致的生产构建', () => {
    const { entryPath } = createValidBuild();
    expect(() => verifyCoreBuildIntegrity(pathToFileURL(entryPath).href)).not.toThrow();
  });

  it('拒绝被修改的生产文件', () => {
    const { entryPath } = createValidBuild();
    writeFileSync(entryPath, 'export const ready = false;\n', 'utf8');
    expect(() => verifyCoreBuildIntegrity(pathToFileURL(entryPath).href)).toThrow('文件摘要不匹配');
  });

  it('拒绝源码已变化但没有重新构建的陈旧产物', () => {
    const { entryPath, sourcePath } = createValidBuild();
    writeFileSync(sourcePath, 'export const ready = false;\n', 'utf8');
    expect(() => verifyCoreBuildIntegrity(pathToFileURL(entryPath).href)).toThrow('源码与生产构建指纹不一致');
  });

  it('拒绝构建后混入的陈旧 JavaScript', () => {
    const { entryPath } = createValidBuild();
    writeFileSync(path.join(path.dirname(entryPath), 'removed-route.js'), 'export {};\n', 'utf8');
    expect(() => verifyCoreBuildIntegrity(pathToFileURL(entryPath).href)).toThrow('多余: removed-route.js');
  });

  it('拒绝缺少构建清单的 JavaScript 入口', () => {
    const { entryPath, manifestPath } = createValidBuild();
    rmSync(manifestPath);
    expect(() => verifyCoreBuildIntegrity(pathToFileURL(entryPath).href)).toThrow('缺少 build-manifest.json');
  });
});
