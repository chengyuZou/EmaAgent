import type {
  CharacterCardId,
  CharacterLive2dId,
} from '@ema-agent/ids';

export type CharacterLive2dFormat = 'live2d' | 'vrm';

export interface CharacterLive2dVariant {
  id: CharacterLive2dId;
  characterCardId: CharacterCardId;
  label: string;
  format: CharacterLive2dFormat;
  /** 角色资源根目录内的模型入口相对路径。 */
  entryPath: string;
  /** 仅 Live2D 运行时需要；VRM 等格式没有该文件。 */
  runtimeConfigPath: string | null;
  position: number;
  isPrimary: boolean;
  enabled: boolean;
  byteSize: number | null;
  isBuiltin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterLive2dVariantInput {
  id?: CharacterLive2dId;
  label: string;
  format: CharacterLive2dFormat;
  entryPath: string;
  runtimeConfigPath?: string | null;
  position?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  byteSize?: number | null;
  isBuiltin?: boolean;
}

export interface CharacterLive2dVariantPatch {
  label?: string;
  position?: number;
  enabled?: boolean;
}

export interface ImportCharacterLive2dInput {
  sourceDirectory: string;
  label: string;
  format: CharacterLive2dFormat;
  entryRelativePath: string;
  runtimeConfigRelativePath?: string | null;
  position?: number;
  isPrimary?: boolean;
}
