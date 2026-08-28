// 输入框只维护有序 TurnInputPart[]，这些纯函数负责文本编辑和引用插入。
import type { TurnInputPart } from '@ema-agent/turn';

type ReferencePart = Exclude<TurnInputPart, { readonly type: 'text' }>;

export function draftText(parts: readonly TurnInputPart[]): string {
  return parts
    .filter((part): part is Extract<TurnInputPart, { readonly type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('');
}

function referencesWithOffsets(parts: readonly TurnInputPart[]): Array<{
  readonly offset: number;
  readonly part: ReferencePart;
}> {
  const result: Array<{ offset: number; part: ReferencePart }> = [];
  let offset = 0;
  for (const part of parts) {
    if (part.type === 'text') offset += part.text.length;
    else result.push({ offset, part });
  }
  return result;
}

function assemble(text: string, references: readonly { offset: number; part: ReferencePart }[]): TurnInputPart[] {
  const result: TurnInputPart[] = [];
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

/** 用 textarea 的新文本替换所有 text part，同时把引用留在原来的文字锚点附近。 */
export function replaceDraftText(
  parts: readonly TurnInputPart[],
  nextText: string,
): TurnInputPart[] {
  const previousText = draftText(parts);
  let prefix = 0;
  while (
    prefix < previousText.length
    && prefix < nextText.length
    && previousText[prefix] === nextText[prefix]
  ) prefix++;

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

/** 在当前文字光标处插入附件或 Skill；同一锚点的引用保持用户选择顺序。 */
export function insertDraftReference(
  parts: readonly TurnInputPart[],
  offset: number,
  part: ReferencePart,
): TurnInputPart[] {
  const text = draftText(parts);
  const references = referencesWithOffsets(parts);
  const safeOffset = Math.max(0, Math.min(text.length, offset));
  let index = references.findIndex(reference => reference.offset > safeOffset);
  if (index < 0) index = references.length;
  references.splice(index, 0, { offset: safeOffset, part });
  return assemble(text, references);
}

export function removeDraftPart(parts: readonly TurnInputPart[], partIndex: number): TurnInputPart[] {
  return parts.filter((_, index) => index !== partIndex);
}

