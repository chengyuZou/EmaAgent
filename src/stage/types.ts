export type CharacterTag =
  | { readonly type: 'emotion'; readonly emotion: string }
  | { readonly type: 'motion'; readonly motion: string };

export interface StageTextPart {
  /** null 表示这次输出只有标签, 不调用 TTS. */
  readonly text: string | null;
  /** null 表示本段没有标签; 标签位于 text 后面, 不等待将来的标签回填. */
  readonly tags: readonly CharacterTag[] | null;
}
