// 按源文件名保存参考音频，并把文件复制、字节写入、导出和删除收在音频子域。

import path from 'node:path';
import type { CharacterSettings } from '../settings.js';
import { sourceBaseName, sourceFileName } from '../resources/resourcePaths.js';
import {
  copyResourceFile,
  exportResourceFile,
  removeFileIfPresent,
  writeResourceFile,
} from '../resources/resourceFiles.js';

export interface ImportedVoiceFile {
  readonly fileName: string;
  readonly displayName: string;
}

export async function importVoiceFile(
  sourceFile: string,
  destinationDirectory: string,
  limits: CharacterSettings['voice'],
): Promise<ImportedVoiceFile> {
  const fileName = sourceFileName(sourceFile);
  await copyResourceFile(sourceFile, path.join(destinationDirectory, fileName), limits.maxBytes);
  return { fileName, displayName: sourceBaseName(sourceFile) };
}

export async function publishVoiceFile(
  destination: string,
  bytes: Uint8Array,
  limits: CharacterSettings['voice'],
): Promise<void> {
  await writeResourceFile(destination, bytes, limits.maxBytes);
}

export { exportResourceFile as exportVoiceFile };
export { removeFileIfPresent as deleteVoiceFile };
