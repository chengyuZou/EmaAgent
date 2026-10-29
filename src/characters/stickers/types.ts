export interface CharacterSticker {
  name: string;
  characterName: string;
  displayName: string;
  // 空描述不加入角色 Prompt, 导入图片后由用户填写.
  description: string;
  byteSize: number;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterStickerPatch {
  displayName: string;
  description: string;
}
