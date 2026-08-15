// 仅凭角色 ID 与资源 ID 推导受管路径，数据库不保存文件位置。

import fs from 'node:fs';
import path from 'node:path';
import { CharacterResourcePathError } from '../errors.js';

export class CharacterResourcePaths {
  constructor(private readonly root: string) {}

  cardRoot(characterId: string): string {
    return path.join(this.root, safeId(characterId));
  }

  live2dDirectory(characterId: string, resourceId: string): string {
    return path.join(this.cardRoot(characterId), 'live2d', safeId(resourceId));
  }

  illustrationImportPath(
    characterId: string,
    resourceId: string,
    extension: string,
  ): string {
    return path.join(
      this.cardRoot(characterId),
      'illustration',
      `${safeId(resourceId)}${normalizeExtension(extension)}`,
    );
  }

  illustrationFile(characterId: string, resourceId: string): string {
    return findResourceFile(
      path.join(this.cardRoot(characterId), 'illustration'),
      safeId(resourceId),
    );
  }

  voiceImportPath(
    characterId: string,
    resourceId: string,
    extension: string,
  ): string {
    return path.join(
      this.cardRoot(characterId),
      'voice',
      `${safeId(resourceId)}${normalizeExtension(extension)}`,
    );
  }

  voiceFile(characterId: string, resourceId: string): string {
    return findResourceFile(
      path.join(this.cardRoot(characterId), 'voice'),
      safeId(resourceId),
    );
  }
}

function findResourceFile(directory: string, resourceId: string): string {
  const matches = fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .filter(entry => entry.name === resourceId || entry.name.startsWith(`${resourceId}.`))
    : [];
  if (matches.length !== 1) {
    throw new CharacterResourcePathError(resourceId, 'resource_file_not_found');
  }
  return path.join(directory, matches[0]!.name);
}

function safeId(value: string): string {
  if (!value || value === '.' || value === '..' || /[\\/:*?"<>|\u0000-\u001f]/u.test(value)) {
    throw new CharacterResourcePathError(value, 'invalid_resource_id');
  }
  return value;
}

function normalizeExtension(extension: string): string {
  if (!/^\.[a-z0-9]{1,10}$/iu.test(extension)) {
    throw new CharacterResourcePathError(extension, 'invalid_file_extension');
  }
  return extension.toLowerCase();
}
