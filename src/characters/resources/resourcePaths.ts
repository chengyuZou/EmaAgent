// 只用数据库中的稳定物理名定位角色资源；可编辑显示名与随机 ID 不参与路径。

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

/**
 * 物理名是一层目录或一个文件名 不允许携带路径
 * 将会进行以下检查
 * - 不能是空字符串
 * - 不能超过 100 个字符
 * - 不能是 . 或 ..
 * - 不能以 . 或 空格结尾
 * - 不能包含 \ / : * ? " < > | 或 ASCII 控制字符
 * - 不能是 Windows 保留设备名 CON PRN AUX NUL COM1-COM9 LPT1-LPT9
 * - 会进行 NFC Unicode 正规化
 */
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
