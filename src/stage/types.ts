export type CharacterTagKind = 'emotion' | 'motion';

export interface ParsedCharacterTag {
  kind: CharacterTagKind;
  /** 标签中的名称. 是否属于当前角色, 由 StageEngine 检查. */
  value: string;
}

export interface ScanResult {
  /** 去掉完整标签及暂存尾部后, 可以立即交给下游的正文. */
  cleaned: string;
  /** 本次识别到的完整标签, 按出现顺序排列, 可包含上一段暂存的文本. */
  tags: ParsedCharacterTag[];
}
