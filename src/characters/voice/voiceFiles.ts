// 按源文件名保存参考音频，并把文件复制、字节写入、导出和删除收在音频子域。

import { MAX_CHARACTER_VOICE_BYTES } from './limits.js';
import { sourceBaseName, sourceFileName } from '../resources/resourcePaths.js';
import {
  copyResourceFile,
  exportResourceFile,
  removeFileIfPresent,
} from '../resources/resourceFiles.js';

export interface ImportedVoiceFile {
  readonly name: string;
  readonly displayName: string;
}

export async function importVoiceFile(
  sourceFile: string,
  destination: string,
): Promise<ImportedVoiceFile> {
  const fileName = sourceFileName(sourceFile);
  await copyResourceFile(sourceFile, destination, MAX_CHARACTER_VOICE_BYTES);
  return { name: fileName, displayName: sourceBaseName(sourceFile) };
}

export { exportResourceFile as exportVoiceFile };
export { removeFileIfPresent as deleteVoiceFile };
