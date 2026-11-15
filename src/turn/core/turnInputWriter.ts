import { logging } from '@ema-agent/logging';
import {
  DEFAULT_SESSION_TITLE,
  type AppendMessageInput,
  type MessageBlocks,
  type SessionMessage,
} from '@ema-agent/session';
import type { SkillPool } from '@ema-agent/skills';
import type { TurnStreamEvent } from '../events.js';
import type { TurnExecutorDeps } from './turnExecutor.js';
import type { PreparedQueueMessage } from '../prepare/prepareTurn.js';
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

  /**
   * 将已准备好的消息(以及可选起始 reminder)放进同一 SQL 事务写入 Messages 表;
   * 事务提交后再确认内存队列预留, 最后通知前端按一对一替换等待气泡.
   */
  function persistPreparedBatch(args: {
    readonly reminderRow?: AppendMessageInput;
    readonly messageItems: readonly PreparedQueueMessage[];
    readonly onReminderPersisted?: () => void;
  }): SessionMessage[] {
    const nonEmptyItems = args.messageItems.filter(item => item.blocks.length > 0);
    const rowsToInsert: AppendMessageInput[] = [
      ...(args.reminderRow ? [args.reminderRow] : []),
      ...nonEmptyItems.map(item => ({
        turnId,
        sessionId,
        role: 'user' as const,
        kind: item.messageKind === 'continuation' ? 'continuation' as const : 'normal' as const,
        blocks: item.blocks,
      })),
    ];

    const firstNormalItem = nonEmptyItems.find(item => item.messageKind === 'normal');
    const shouldRename = firstNormalItem !== undefined
      && deps.sessions.getSession(sessionId).title === DEFAULT_SESSION_TITLE
      && !deps.hasNormalUserMessage(sessionId);

    const storedRows = deps.sessions.appendTurnMessages(sessionId, rowsToInsert);
    const storedMessages = args.reminderRow ? storedRows.slice(1) : storedRows;

    if (args.reminderRow) {
      args.onReminderPersisted?.();
    }
    if (shouldRename && firstNormalItem) {
      try {
        deps.sessions.updateTitleIfDefault(sessionId, createSessionTitle(firstNormalItem.blocks));
      } catch (error) {
        // 正文已经保存. 自动标题失败不能丢弃这批输入.
        logging({
          level: 'warn',
          target: 'turn',
          event: 'turn.session_title_failed',
          error,
          body: { sessionId, turnId },
        });
      }
    }

    const queuedInputIds = deps.messageQueue.confirmMessageSaved(sessionId, turnId);
    const storedNormalMessages = storedMessages.filter(
      (_, index) => nonEmptyItems[index]?.messageKind === 'normal',
    );
    if (storedNormalMessages.length > 0) {
      emit({ type: 'user_messages_stored', messages: storedNormalMessages, queuedInputIds });
    }
    return storedMessages;
  }

  async function writeInitialMessages(
    preparedMessages: readonly PreparedQueueMessage[],
    characterName: string,
  ): Promise<string | undefined> {
    const userText = preparedMessages
      .filter(item => item.messageKind === 'normal')
      .map(item => explicitUserText(item.blocks))
      .filter(Boolean)
      .join('\n\n');
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

    persistPreparedBatch({
      reminderRow: {
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
      },
      messageItems: preparedMessages,
      // reminder 已持久化成功:宿主在此提交"已提醒"(Task reminder 两阶段提交点).
      // 放在 appendTurnMessages 之后,保证 Turn 准备失败不会吞掉低频提醒周期.
      onReminderPersisted: () => {
        if (reminderInput.taskReminder?.trim()) {
          deps.onTaskReminderPersisted?.(sessionId);
        }
      },
    });

    return handledGoalId;
  }

  const takeNextIterationMessages = async (): Promise<SessionMessage[]> => {
    const appended: SessionMessage[] = [];
    while (true) {
      const queueMessages = deps.messageQueue.reserveNextIterationMessages(sessionId, turnId);
      if (queueMessages.length === 0) return appended;
      try {
        // 先完成全部附件与 Skill 异步准备并校验未中止, 再进入同步 SQL 事务整批写库.
        const preparedItems: PreparedQueueMessage[] = [];
        for (const queueMessage of queueMessages) {
          const blocks = await prepareTurnInputParts(
            deps.attachments,
            sessionId,
            turnId,
            queueMessage.input,
            skillPool,
          );
          preparedItems.push({
            messageKind: queueMessage.messageKind,
            input: queueMessage.input,
            blocks,
          });
        }
        signal.throwIfAborted();

        if (queueMessages.some(message => (
          message.messageKind === 'normal'
          && message.input.some(part => part.type === 'text' && part.text.trim().length > 0)
        ))) {
          deps.computerUse?.noteUserInput(sessionId);
        }

        const stored = persistPreparedBatch({ messageItems: preparedItems });
        appended.push(...stored);
      } catch (error) {
        deps.messageQueue.releaseReservedMessage(sessionId, turnId);
        throw error;
      }
    }
  };

  return { writeInitialMessages, takeNextIterationMessages };
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

