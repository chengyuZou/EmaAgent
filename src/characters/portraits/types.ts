import type {
  CharacterCardId,
  CharacterPortraitId,
} from '@ema-agent/ids';

export type CharacterPortraitMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface CharacterPortrait {
  id: CharacterPortraitId;
  characterCardId: CharacterCardId;
  label: string;
  /** 角色资源根目录内的图片相对路径。 */
  relativePath: string;
  position: number;
  isPrimary: boolean;
  enabled: boolean;
  mimeType: CharacterPortraitMime;
  byteSize: number;
  width: number;
  height: number;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterPortraitInput {
  id?: CharacterPortraitId;
  label: string;
  relativePath: string;
  position?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  mimeType: CharacterPortraitMime;
  byteSize: number;
  width: number;
  height: number;
}

export interface CharacterPortraitPatch {
  label?: string;
  position?: number;
  enabled?: boolean;
}

export interface ImportCharacterPortraitInput {
  sourceFile: string;
  label: string;
  position?: number;
  isPrimary?: boolean;
}
