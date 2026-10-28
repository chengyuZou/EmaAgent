import { DEFAULT_SESSION_TITLE, type MessageBlocks, type SessionMessage } from '@ema-agent/session';
import type { SkillPool } from '@ema-agent/skills';
import type { TurnStreamEvent } from '../events.js';
import type { StartTurn } from '../types.js';
import type { TurnExecutorDeps } from './turnExecutor.js';
import type { ClaimedSessionContinuation } from '../continuation/continuationTypes.js';
import { prepareTurnInputParts } from '../prepare/turnInputParts.js';
import { renderTurnReminder } from '../reminder/turnReminder.js';

export function createTurnInputWriter(
  deps: TurnExecutorDeps,
  inputContext: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly signal: AbortSignal;
    readonly skillPool: SkillPool | undefined;
    readonly emit: (event: TurnStreamEvent) => void;
  },
) {
  const { sessionId, turnId, signal, skillPool, emit } = inputContext;

  function appendUserMessage(blocks: MessageBlocks): SessionMessage {
    const shouldRename = deps.sessions.getSession(sessionId).title === DEFAULT_SESSION_TITLE
      && !deps.hasNormalUserMessage(sessionId);
    const message = deps.sessions.appendMessage({ sessionId, turnId, role: 'user', blocks });
    if (shouldRename) {
      try {
        deps.sessions.updateTitleIfDefault(sessionId, createSessionTitle(blocks));
      } catch (error) {
        // 正文已经保存. 自动标题失败不能丢弃这条输入.
        console.warn('[turn] 自动命名会话失败:', error);
      }
    }
    return message;
  }

  async function writeInitialInput(
    input: StartTurn,
    blocks: MessageBlocks,
    characterName: string,
  ): Promise<string | undefined> {
    const userText = explicitUserText(blocks);
    const previousCharacterName = deps.turns.getPreviousCharacterName(sessionId, turnId);
    // Reminder 先于用户消息落库:同一 Turn 的历史重放顺序即模型看到的顺序.
    // reminder 表示"本 Turn 开始时的事实",整 Turn 只有这一条,不随 LLM Call 重建.
    const reminderInput = await deps.readTurnReminder({
      sessionId,
      turnId,
      characterName,
      userText,
      signal,
      emit,
    });
    // 等待期间可能已归档或删除, 尚未交付的输入不能在停止后写入历史.
    signal.throwIfAborted();
    const handledGoalId = reminderInput.goal?.status === 'active' ? reminderInput.goal.id : undefined;
    deps.sessions.appendMessage({
      turnId,
      sessionId,
      role: 'user',
      kind: 'reminder',
      blocks: renderTurnReminder({
        ...reminderInput,
        characterSwitch: previousCharacterName && previousCharacterName !== characterName
          ? { previousCharacterName, currentCharacterName: characterName }
          : undefined,
      }),
    });
    // reminder 已持久化成功:宿主在此提交"已提醒"(Task reminder 两阶段提交点).
    // 放在 appendMessage 之后,保证 Turn 准备失败不会吞掉低频提醒周期.
    if (reminderInput.taskReminder?.trim()) {
      deps.onTaskReminderPersisted?.(sessionId);
    }

    // 内部完成通知与 Goal 续接共用 Message kind, 不伪装成用户手写内容.
    if (input.continuationText) {
      deps.sessions.appendMessage({
        turnId,
        sessionId,
        role: 'user',
        kind: 'continuation',
        blocks: input.continuationText,
      });
    }
    if (blocks.length > 0) {
      const userMessage = appendUserMessage(blocks);
      const queuedInputIds = deps.continuations.acknowledge(turnId);
      emit({ type: 'user_message_stored', message: userMessage, queuedInputIds });
    } else {
      deps.continuations.acknowledge(turnId);
    }

    return handledGoalId;
  }

  const persistClaim = async (
    claim: ClaimedSessionContinuation,
  ): Promise<SessionMessage> => {
    if (claim.inputKind === 'continuationText') {
      // 内部续接文本不在聊天显示, 只持久化并交给模型.
      return deps.sessions.appendMessage({
        turnId,
        sessionId,
        role: 'user',
        kind: 'continuation',
        blocks: claim.continuationText,
      });
    }

    const blocks = await prepareTurnInputParts(
      deps.attachments,
      sessionId,
      turnId,
      claim.input,
      skillPool,
    );
    signal.throwIfAborted();

    if (claim.input.some(part => part.type === 'text' && part.text.trim().length > 0)) {
      deps.computerUse?.noteUserInput(sessionId);
    }

    return appendUserMessage(blocks);
  };

  const takeNextIterationMessages = async (): Promise<SessionMessage[]> => {
    const appended: SessionMessage[] = [];
    while (true) {
      const claim = deps.continuations.claimNextIteration(sessionId, turnId);
      if (!claim) return appended;
      try {
        const message = await persistClaim(claim);
        appended.push(message);
        const queuedInputIds = deps.continuations.acknowledge(turnId);
        if (claim.inputKind === 'messageInput') {
          emit({ type: 'user_message_stored', message, queuedInputIds });
        }
      } catch (error) {
        deps.continuations.release(turnId);
        throw error;
      }
    }
  };

  return { writeInitialInput, takeNextIterationMessages };
}

/** Reminder 的用户文本只取显式正文, 不混入附件描述或 Skill 指引. */
function explicitUserText(blocks: MessageBlocks): string {
  if (typeof blocks === 'string') return blocks;
  return blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('');
}

const AUTO_SESSION_TITLE_LENGTH = 30;
const IMAGE_SESSION_TITLE = '图片';
const FILE_SESSION_TITLE = '附件';
// 按完整可见字符截取, 不拆开组合 emoji 或带重音的字符.
const titleSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function createSessionTitle(blocks: MessageBlocks): string {
  let source: string;
  if (typeof blocks === 'string') {
    source = blocks;
  } else {
    const texts: string[] = [];
    const previews: string[] = [];
    const files: string[] = [];
    const skills: string[] = [];
    let imageCount = 0;
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          texts.push(block.text);
          break;
        case 'pasted_text_reference':
          previews.push(block.preview);
          break;
        case 'file_reference':
          files.push(block.path.split(/[\\/]/).pop() || FILE_SESSION_TITLE);
          break;
        case 'image_reference':
          imageCount += 1;
          break;
        case 'skill_reference':
          skills.push(block.name);
          break;
      }
    }
    source = texts.join(' ').trim() || previews.join(' ').trim();
    if (!source) {
      const attachmentCount = files.length + imageCount;
      if (files.length > 0) {
        source = files[0]!;
        if (attachmentCount > 1) {
          source = `${source} 等 ${attachmentCount} 个附件`;
        }
      } else if (imageCount > 0) {
        source = IMAGE_SESSION_TITLE;
        if (imageCount > 1) {
          source = `${imageCount} 张图片`;
        }
      } else if (skills.length > 0) {
        source = skills[0]!;
        if (skills.length > 1) {
          source = `${source} 等 ${skills.length} 个技能`;
        }
      }
    }
  }
  const normalized = source.replace(/\s+/gu, ' ').trim() || DEFAULT_SESSION_TITLE;
  let title = '';
  let length = 0;
  for (const part of titleSegmenter.segment(normalized)) {
    if (length === AUTO_SESSION_TITLE_LENGTH) break;
    title += part.segment;
    length += 1;
  }
  return title;
}

