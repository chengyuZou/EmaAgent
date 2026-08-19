// 发现 Live2D 目录内唯一的模型入口与运行配置，并确认两份 JSON 可以读取。

import fs from 'node:fs';
import path from 'node:path';
import { CharacterResourceValidationError } from '../errors.js';

export interface Live2dPackageFiles {
  readonly modelPath: string;
  readonly runtimeConfigPath: string | null;
}

export function findLive2dPackageFilesSync(directory: string): Live2dPackageFiles {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    throw new CharacterResourceValidationError('source_directory_required');
  }
  if (!stat.isDirectory()) {
    throw new CharacterResourceValidationError('source_directory_required');
  }
  const files = listFilesSync(directory);
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
  readJsonObjectSync(modelPaths[0]!, 'live2d_entry_invalid');
  if (runtimeConfigPaths[0]) {
    readJsonObjectSync(runtimeConfigPaths[0], 'live2d_runtime_config_invalid');
  }
  return { modelPath: modelPaths[0]!, runtimeConfigPath: runtimeConfigPaths[0] ?? null };
}

function listFilesSync(root: string): string[] {
  const result: string[] = [];
  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolutePath);
      else if (entry.isFile()) result.push(absolutePath);
    }
  }
  walk(root);
  return result;
}

function readJsonObjectSync(
  filePath: string,
  reason: 'live2d_entry_invalid' | 'live2d_runtime_config_invalid',
): void {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('JSON root is not an object');
    }
  } catch {
    throw new CharacterResourceValidationError(reason);
  }
}
