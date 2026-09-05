// 把 Live2D ZIP 直接解压到稳定目录，或把已展开目录流式导出为 ZIP。

import fs from 'node:fs';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { Unzip, UnzipInflate, Zip, ZipDeflate } from 'fflate';
import { CharacterResourceValidationError } from '../errors.js';
import { physicalName, sourceBaseName } from '../resources/resourcePaths.js';
import { removeDirectoryIfPresent, removeFileIfPresent } from '../resources/resourceFiles.js';

export interface ImportedLive2dFiles {
  readonly name: string;
  readonly displayName: string;
  readonly byteSize: number;
}

export interface Live2dFiles {
  readonly modelPath: string;
  readonly runtimeConfigPath: string | null;
}

/**
 * 常见资源包不是一组同级文件, 而是下面这种目录树:
 *
 * ```text
 * ema.model3.json              Cubism 模型入口
 * ema.moc3                     模型二进制
 * ema.8192/texture_00.png      贴图可以位于子目录
 * expressions/happy.exp3.json 表情也可以位于子目录
 * motions/idle.motion3.json    动作也可以位于子目录
 * runtime-config.json          Ema 语义映射, 可选
 * ```
 *
 * 所以这里递归查找整个资源目录, 但最终只允许一个 `.model3.json` 入口和至多一个
 * `runtime-config.json`. 其他文件的准确位置由 model3.json 自己的相对引用决定.
 */
export async function findLive2dFiles(directory: string): Promise<Live2dFiles> {
  const stat = await fs.promises.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new CharacterResourceValidationError('source_directory_required');
  }
  return selectLive2dFiles(await listFiles(directory));
}

// Presentation 与 Prompt 当前是同步契约，只在这条读取路径保留同步目录扫描。
export function findLive2dFilesSync(directory: string): Live2dFiles {
  const stat = fs.statSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    throw new CharacterResourceValidationError('source_directory_required');
  }
  return selectLive2dFiles(listFilesSync(directory));
}

function selectLive2dFiles(files: readonly string[]): Live2dFiles {
  const modelPaths = files.filter(file => file.toLowerCase().endsWith('.model3.json'));
  const runtimeConfigPaths = files.filter(
    file => path.basename(file).toLowerCase() === 'runtime-config.json',
  );
  if (modelPaths.length !== 1) {
    throw new CharacterResourceValidationError('live2d_entry_invalid');
  }
  if (runtimeConfigPaths.length > 1) {
    throw new CharacterResourceValidationError('live2d_runtime_config_invalid');
  }
  return {
    modelPath: modelPaths[0]!,
    runtimeConfigPath: runtimeConfigPaths[0] ?? null,
  };
}

export async function importLive2dFiles(
  sourcePath: string,
  destination: string,
): Promise<ImportedLive2dFiles> {
  const source = await fs.promises.stat(sourcePath).catch(() => null);
  if (!source || (!source.isDirectory() && (!source.isFile() || path.extname(sourcePath).toLowerCase() !== '.zip'))) {
    throw new CharacterResourceValidationError('source_file_required');
  }
  const name = source.isDirectory() ? physicalName(path.basename(sourcePath)) : sourceBaseName(sourcePath);
  if (fs.existsSync(destination)) {
    throw new CharacterResourceValidationError('resource_name_conflict');
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });

  // 目录名在导入时就成为资源身份；失败必须移除半成品，不能留下占用同名身份的目录。
  try {
    const byteSize = source.isDirectory()
      ? await copyDirectory(sourcePath, destination)
      : await extractZip(sourcePath, destination);
    return { name, displayName: name, byteSize };
  } catch (error) {
    await removeDirectoryIfPresent(destination);
    throw error;
  }
}

async function copyDirectory(source: string, destination: string): Promise<number> {
  await fs.promises.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  const files = await listLive2dFiles(destination);
  let byteSize = 0;
  for (const file of files) byteSize += (await fs.promises.stat(file)).size;
  return byteSize;
}

export async function exportLive2dZip(
  sourceDirectory: string,
  destinationDirectory: string,
  displayName: string,
): Promise<string> {
  const destination = await fs.promises.stat(destinationDirectory).catch(() => null);
  if (!destination?.isDirectory()) {
    throw new CharacterResourceValidationError('destination_directory_required');
  }
  const target = path.join(destinationDirectory, `${physicalName(displayName.trim())}.zip`);
  let descriptor: number;
  // fflate 逐文件消费流，避免导出大型模型时把整个目录或 ZIP 一次性放进内存。
  try {
    descriptor = fs.openSync(target, 'wx');
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new CharacterResourceValidationError('export_destination_exists');
    }
    throw error;
  }

  try {
    const files = await listLive2dFiles(sourceDirectory);

    const zip = new Zip((error, chunk) => {
      if (error) throw error;
      if (chunk.byteLength > 0) fs.writeSync(descriptor, chunk);
    });
    for (const file of files) {
      const entry = new ZipDeflate(
        path.relative(sourceDirectory, file).split(path.sep).join('/'),
        { level: 6 },
      );
      zip.add(entry);
      for await (const chunk of fs.createReadStream(file)) {
        entry.push(chunk);
      }
      entry.push(new Uint8Array(), true);
    }
    zip.end();
    fs.closeSync(descriptor);
    return target;
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* descriptor may already be closed */ }
    await removeFileIfPresent(target);
    if (error instanceof CharacterResourceValidationError) throw error;
    throw new CharacterResourceValidationError('zip_invalid');
  }
}

export { removeDirectoryIfPresent as deleteLive2dDirectory };

async function extractZip(
  sourceZipFile: string,
  destination: string,
): Promise<number> {
  await fs.promises.mkdir(destination, { recursive: false });
  const openFiles = new Set<number>();
  let expandedBytes = 0;
  try {
    const unzip = new Unzip((file) => {
      const entryPath = normalizeEntryPath(file.name);
      const isDirectory = entryPath.endsWith('/');
      const target = path.join(destination, ...entryPath.split('/').filter(Boolean));
      fs.mkdirSync(isDirectory ? target : path.dirname(target), { recursive: true });
      let descriptor: number | null = isDirectory ? null : fs.openSync(target, 'wx');
      if (descriptor !== null) openFiles.add(descriptor);
      file.ondata = (error, chunk, final) => {
        if (error) throw new CharacterResourceValidationError('zip_invalid');
        expandedBytes += chunk.byteLength;
        if (descriptor !== null && chunk.byteLength > 0) fs.writeSync(descriptor, chunk);
        if (final && descriptor !== null) {
          fs.closeSync(descriptor);
          openFiles.delete(descriptor);
          descriptor = null;
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for await (const chunk of fs.createReadStream(sourceZipFile)) {
      unzip.push(chunk, false);
    }
    unzip.push(new Uint8Array(), true);
    if (openFiles.size > 0) {
      throw new CharacterResourceValidationError('zip_invalid');
    }
    return expandedBytes;
  } catch (error) {
    for (const descriptor of openFiles) {
      try { fs.closeSync(descriptor); } catch { /* cleanup after ZIP failure */ }
    }
    if (error instanceof CharacterResourceValidationError) throw error;
    throw new CharacterResourceValidationError('zip_invalid');
  }
}

function normalizeEntryPath(value: string): string {
  const parts = value.replace(/\/$/u, '').split('/');
  if (
    !value
    || value.includes('\\')
    || value.startsWith('/')
    || /^[a-z]:/iu.test(value)
    || parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new CharacterResourceValidationError('zip_entry_path_invalid');
  }
  return value;
}

export async function listLive2dFiles(root: string): Promise<string[]> {
  const stat = await fs.promises.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new CharacterResourceValidationError('resource_type_unsupported');
  }
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  }
  await walk(root);
  return files.sort();
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort();
}

function listFilesSync(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.push(path.join(entry.parentPath, entry.name));
  }
  return files.sort();
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
