
import path from 'node:path';
import { CharacterResourcePathError } from '../errors.js';

export class CharacterResourcePaths {
  constructor(private readonly root: string) {}

  charactersRoot(): string {
    return this.root;
  }

  stagingRoot(): string {
    return path.join(this.root, '.staging');
  }

  stagingOperationDirectory(operationId: string): string {
    return path.join(this.stagingRoot(), physicalName(operationId));
  }

  // 封面单独保存在 .previews, 不进入模型目录, 因而不会混入导出的模型 ZIP.
  previewRoot(characterName: string): string {
    return path.join(this.characterDirectory(characterName), '.previews');
  }

  live2dPreviewFile(characterName: string, live2dName: string): string {
    return path.join(this.previewRoot(characterName), `${physicalName(live2dName)}.png`);
  }

  characterDirectory(characterName: string): string {
    return path.join(this.root, physicalName(characterName));
  }

  live2dRoot(characterName: string): string {
    return path.join(this.characterDirectory(characterName), 'live2d');
  }

  live2dModelDirectory(characterName: string, live2dName: string): string {
    return path.join(
      this.live2dRoot(characterName),
      physicalName(live2dName),
    );
  }

  illustrationRoot(characterName: string): string {
    return path.join(this.characterDirectory(characterName), 'illustration');
  }

  illustrationFile(characterName: string, illustrationName: string): string {
    return path.join(
      this.illustrationRoot(characterName),
      physicalName(illustrationName),
    );
  }

  stickerFile(characterName: string, name: string): string {
    return path.join(this.characterDirectory(characterName), 'stickers', physicalName(name));
  }

  voiceRoot(characterName: string): string {
    return path.join(this.characterDirectory(characterName), 'voice');
  }

  voiceFile(characterName: string, voiceName: string): string {
    return path.join(
      this.voiceRoot(characterName),
      physicalName(voiceName),
    );
  }
}

/** 名称同时用于 SQL 和文件系统. 统一为 NFC 并按 Windows 文件名限制校验, 使资源可以跨平台搬移. */
export function physicalName(value: string): string {
  const normalized = value.normalize('NFC');
  const stem = normalized.split('.')[0] ?? normalized;
  if (
    !normalized
    || normalized.length > 100
    || normalized === '.'
    || normalized === '..'
    || normalized.endsWith('.')
    || normalized.endsWith(' ')
    || path.basename(normalized) !== normalized
    || /[\\/:*?"<>|\u0000-\u001f]/u.test(normalized)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(stem)
  ) {
    throw new CharacterResourcePathError(value, 'physical_name_invalid');
  }
  return normalized;
}

export function sourceFileName(sourcePath: string): string {
  return physicalName(path.basename(sourcePath));
}

export function sourceBaseName(sourcePath: string): string {
  const fileName = sourceFileName(sourcePath);
  return physicalName(fileName.slice(0, fileName.length - path.extname(fileName).length));
}

export function displayFileName(name: string, extension: string): string {
  return `${physicalName(name.trim())}${extension.toLowerCase()}`;
}
