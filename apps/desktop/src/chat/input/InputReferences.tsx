// 保存输入框的有序引用草稿, 并在真正发送时把未落盘附件转换为 Turn 输入.
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/session';
import type { PermissionMode } from '@ema-agent/permission';
import type { TurnInputPart, TurnModelSelection } from '@ema-agent/turn';

export type ChatDraftPart =
  | Extract<TurnInputPart, { readonly type: 'text' | 'skill_reference' }>
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'image'; readonly sourcePath?: string; readonly file?: File; readonly name?: string }
  | { readonly type: 'pasted_text'; readonly content: string; readonly preview: string };

export interface ChatDraft {
  readonly parts: readonly ChatDraftPart[];
  readonly selectedAssetIds: readonly string[];
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  readonly permissionMode: PermissionMode;
  readonly modelSelection?: TurnModelSelection;
}

export function emptyChatDraft(): ChatDraft {
  return {
    parts: [],
    selectedAssetIds: [],
    executionProfile: 'chat',
    narrativePolicy: 'auto',
    permissionMode: 'default',
  };
}

type ReferencePart = Exclude<ChatDraftPart, { readonly type: 'text' }>;

export function draftText(parts: readonly ChatDraftPart[]): string {
  return parts
    .filter((part): part is Extract<ChatDraftPart, { readonly type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('');
}

export function hasDraftContent(parts: readonly ChatDraftPart[]): boolean {
  return parts.some(part => part.type !== 'text' || part.text.trim().length > 0);
}

function referencesWithOffsets(parts: readonly ChatDraftPart[]): Array<{ readonly offset: number; readonly part: ReferencePart }> {
  const result: Array<{ offset: number; part: ReferencePart }> = [];
  let offset = 0;
  for (const part of parts) {
    if (part.type === 'text') offset += part.text.length;
    else result.push({ offset, part });
  }
  return result;
}

function assemble(text: string, references: readonly { offset: number; part: ReferencePart }[]): ChatDraftPart[] {
  const result: ChatDraftPart[] = [];
  let cursor = 0;
  for (const reference of references) {
    const offset = Math.max(cursor, Math.min(text.length, reference.offset));
    if (offset > cursor) result.push({ type: 'text', text: text.slice(cursor, offset) });
    result.push(reference.part);
    cursor = offset;
  }
  if (cursor < text.length) result.push({ type: 'text', text: text.slice(cursor) });
  return result;
}

/** Textarea 只编辑文字, 非文本引用仍留在原来的文字锚点附近. */
export function replaceDraftText(parts: readonly ChatDraftPart[], nextText: string): ChatDraftPart[] {
  const previousText = draftText(parts);
  let prefix = 0;
  while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < previousText.length - prefix
    && suffix < nextText.length - prefix
    && previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) suffix++;

  const previousTail = previousText.length - suffix;
  const nextTail = nextText.length - suffix;
  const references = referencesWithOffsets(parts).map(({ offset, part }) => {
    if (offset <= prefix) return { offset, part };
    if (offset >= previousTail) return { offset: nextTail + offset - previousTail, part };
    return { offset: nextTail, part };
  });
  return assemble(nextText, references);
}

/** 同一文字锚点的附件与 Skill 保持用户加入顺序. */
export function insertDraftReference(parts: readonly ChatDraftPart[], offset: number, part: ReferencePart): ChatDraftPart[] {
  const text = draftText(parts);
  const references = referencesWithOffsets(parts);
  const safeOffset = Math.max(0, Math.min(text.length, offset));
  let index = references.findIndex(reference => reference.offset > safeOffset);
  if (index < 0) index = references.length;
  references.splice(index, 0, { offset: safeOffset, part });
  return assemble(text, references);
}

export function removeDraftPart(parts: readonly ChatDraftPart[], partIndex: number): ChatDraftPart[] {
  return parts.filter((_, index) => index !== partIndex);
}
