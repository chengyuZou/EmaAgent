import type { AttachmentStore } from '@ema-agent/attachments';
import type { AttachmentBlock, MessageBlocks, SessionUserBlock } from '@ema-agent/session';
import type { SkillDescriptor, SkillPool } from '@ema-agent/skills';
import type { TurnInputPart } from '../types.js';
import { TurnPreparationError } from '../errors.js';

/**
 * 初始输入和运行中立即引导共用这一条解析链. Skill 必须先确认存在,
 * 然后附件才登记到 Turn, 避免无效 Skill 留下孤立附件记录.
 */
export async function prepareTurnInputParts(
  attachments: AttachmentStore,
  sessionId: string,
  turnId: string,
  input: readonly TurnInputPart[],
  skillPool: SkillPool | undefined,
): Promise<MessageBlocks> {
  const selectedSkills = resolveSelectedSkills(input, skillPool);
  const attachmentBlocks = input
    .filter((part): part is Extract<TurnInputPart, { type: 'attachment' }> => part.type === 'attachment')
    .map(part => part.block);
  let attachedBlocks: readonly AttachmentBlock[] = [];
  try {
    attachedBlocks = attachmentBlocks.length > 0
      ? await attachments.attach(sessionId, turnId, attachmentBlocks)
      : [];
  } catch (error) {
    throw new TurnPreparationError(
      'turn/attachment_failed',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  return prepareOrderedInput(input, attachedBlocks, selectedSkills);
}

function prepareOrderedInput(
  input: readonly TurnInputPart[],
  attachedBlocks: readonly AttachmentBlock[],
  selectedSkills: ReadonlyMap<string, SkillDescriptor>,
): MessageBlocks {
  const sessionBlocks: SessionUserBlock[] = [];
  let attachmentIndex = 0;

  for (const part of input) {
    if (part.type === 'text') {
      if (part.text.length === 0) continue;
      sessionBlocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'attachment') {
      const block = attachedBlocks[attachmentIndex++];
      if (!block) {
        throw new TurnPreparationError('turn/attachment_failed', '附件校验结果缺少对应块');
      }
      sessionBlocks.push(block);
      continue;
    }

    const descriptor = selectedSkills.get(part.path)!;
    sessionBlocks.push({
      type: 'skill_reference',
      name: descriptor.name,
      path: descriptor.path,
    });
  }

  return sessionBlocks.length === 1
    && sessionBlocks[0]?.type === 'text'
    ? sessionBlocks[0].text
    : sessionBlocks;
}

/** Skill Chip 提交绝对 SKILL.md path;准备期解析成当前 Pool 中已经冻结的描述符. */
function resolveSelectedSkills(
  input: readonly TurnInputPart[],
  skillPool: SkillPool | undefined,
): ReadonlyMap<string, SkillDescriptor> {
  const selected = new Map<string, SkillDescriptor>();
  for (const part of input) {
    if (part.type !== 'skill_reference' || selected.has(part.path)) continue;
    const descriptor = skillPool?.getByPath(part.path);
    if (!descriptor) {
      throw new TurnPreparationError(
        'turn/setup_failed',
        `选择的 Skill 不存在或已被禁用: ${part.path}`,
      );
    }
    selected.set(part.path, descriptor);
  }
  return selected;
}
