// 只用数据库中的稳定物理名定位角色资源；可编辑显示名与随机 ID 不参与路径。

import path from 'node:path';
import { CharacterResourcePathError } from '../errors.js';

export class CharacterResourcePaths {
  constructor(private readonly root: string) {}

  charactersRoot(): string {
    return this.root;
  }

  characterDirectory(characterDirectoryName: string): string {
    return path.join(this.root, physicalName(characterDirectoryName));
  }

  live2dRoot(characterDirectoryName: string): string {
    return path.join(this.characterDirectory(characterDirectoryName), 'live2d');
  }

  live2dModelDirectory(characterDirectoryName: string, modelDirectoryName: string): string {
    return path.join(
      this.live2dRoot(characterDirectoryName),
      physicalName(modelDirectoryName),
    );
  }

  illustrationRoot(characterDirectoryName: string): string {
    return path.join(this.characterDirectory(characterDirectoryName), 'illustration');
  }

  illustrationFile(characterDirectoryName: string, fileName: string): string {
    return path.join(
      this.illustrationRoot(characterDirectoryName),
      physicalName(fileName),
    );
  }

  voiceRoot(characterDirectoryName: string): string {
    return path.join(this.characterDirectory(characterDirectoryName), 'voice');
  }

  voiceFile(characterDirectoryName: string, fileName: string): string {
    return path.join(
      this.voiceRoot(characterDirectoryName),
      physicalName(fileName),
    );
  }
}

/** 物理名是一层目录或一个文件名，不允许携带路径。 */
export function physicalName(value: string): string {
  if (
    !value
    || value === '.'
    || value === '..'
    || path.basename(value) !== value
    || /[\\/:*?"<>|\u0000-\u001f]/u.test(value)
  ) {
    throw new CharacterResourcePathError(value, 'physical_name_invalid');
  }
  return value;
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
