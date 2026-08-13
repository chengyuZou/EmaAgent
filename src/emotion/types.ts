// ── 角色表现标签类型 ───────────────────────────────────────────────────────────

export type CharacterTagKind = 'emotion' | 'motion';

export interface ParsedCharacterTag {
  kind: CharacterTagKind;
  /** 当前角色运行配置声明的情绪或动作名称。 */
  value: string;
  /** 完整原始标签，例如 `<emotion>happy</emotion>`。 */
  raw: string;
}

// ── Scanner result ────────────────────────────────────────────────────────────

export interface ScanResult {
  /** 去除所有完整角色表现标签后的文本。 */
  cleaned: string;
  /** 在此 delta 中找到的所有完整角色表现标签（按顺序）。 */
  tags: ParsedCharacterTag[];
}
