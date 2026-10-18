
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
