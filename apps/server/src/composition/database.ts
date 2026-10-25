import {
  SubagentMessagesRepo,
  SubagentsRepo,
  SubagentRunsRepo,
  MessagesRepo,
  AttachmentImagesRepo,
  AttachmentPastedTextsRepo,
  Database,
  DataDirStatsRepo,
  SessionStatsRepo,
  TasksRepo,
  SpeechOutputsRepo,
  ToolExecutionsRepo,
} from '@ema-agent/storage';
import { SubagentMessagesStore, SubagentStore } from '@ema-agent/agent';
import { AttachmentStore, ImageStore, PastedTextStore, type AttachmentEvent } from '@ema-agent/attachments';
import { SessionRunningRegistry, SessionStore, type SessionEvent } from '@ema-agent/session';
import { TaskStore, type TaskEvent } from '@ema-agent/tasks';
import { TurnStore } from '@ema-agent/turn';
import { UsageRecorder } from '@ema-agent/usage';
import { GoalStore, type GoalEvent } from '@ema-agent/goal';
import {
  dataDbPathFor,
  profileDbPath,
  narrativeDbPath,
  preMigrationDir,
  removeOrphanSessionDirectories,
  removeSessionFiles,
  removeTurnFiles,
} from '../platform/paths.js';

export interface DatabaseComposition {
  /** 当前 Profile 的配置库, 保存 Provider, 模型绑定, 角色和设置. */
  readonly profileDb: Database;
  /** `{activeDataDir}/data.db`:Session/Turn/Message/附件/后台进程. */
  readonly dataDb: Database;
  /** 固定剧情资产, 不随会话数据目录或角色切换. */
  readonly narrativeDb: Database;
  /** 当前活动数据目录绝对路径;文件类存储(附件, 音频, 后台日志)都落在它下面. */
  readonly activeDataDir: string;

  readonly session: SessionStore;
  readonly turns: TurnStore;
  /** Turn 与手动 Compact 共用, 用于阻止同一 Session 同时开始两项工作. */
  readonly sessionRunning: SessionRunningRegistry;
  readonly attachments: AttachmentStore;
  /** 粘贴端点直接调用;attachmentStore 内部共享同一实例. */
  readonly imageStore: ImageStore;
  readonly pasteStore: PastedTextStore;
  /** 附件页路由直接查询的两本账. */
  readonly attachmentImages: AttachmentImagesRepo;
  readonly attachmentPastedTexts: AttachmentPastedTextsRepo;
  readonly tasks: TaskStore;
  readonly goals: GoalStore;
  readonly subagents: SubagentStore;
  readonly subagentMessages: SubagentMessagesStore;
  /** 全部能力调用与用量查询共享的 Recorder, 不发应用事件. */
  readonly usageRecorder: UsageRecorder;
  /** raw 消息只读投影(存储页消息查看器). */
  readonly messages: MessagesRepo;
  readonly subagentMessageRecords: SubagentMessagesRepo;
  readonly toolExecutions: ToolExecutionsRepo;
  readonly speechOutputs: SpeechOutputsRepo;
  /** 数据目录/单 Session 的存储统计只读投影. */
  readonly dataDirStats: DataDirStatsRepo;
  readonly sessionStats: SessionStatsRepo;

  /** 关闭三个数据库;进程关闭序列的最后一步. */
  close(): void;
}

/**
 * 打开并迁移三个数据库,构造全部存储层 Store.
 * activeDataDir 由 lifecycle 按当前 Profile 路径传入.
 */
export async function openDatabases(
  activeDataDir: string,
  emitChanged: (
    event: SessionEvent | AttachmentEvent | TaskEvent | GoalEvent,
  ) => void,
): Promise<DatabaseComposition> {
  const profileDb = new Database({ path: profileDbPath(), kind: 'profile' });
  try {
    await profileDb.migrate(preMigrationDir());
  } catch (err) {
    profileDb.close();
    throw err;
  }

  const dataDb = new Database({ path: dataDbPathFor(activeDataDir), kind: 'data' });
  try {
    await dataDb.migrate(preMigrationDir());
  } catch (err) {
    dataDb.close();
    profileDb.close();
    throw err;
  }

  const narrativeDb = new Database({ path: narrativeDbPath(), kind: 'narrative' });
  try {
    await narrativeDb.migrate();
  } catch (error) {
    narrativeDb.close();
    dataDb.close();
    profileDb.close();
    throw error;
  }

  const usageRecorder = new UsageRecorder(dataDb);
  const messages = new MessagesRepo(dataDb.sqlite);
  const subagentMessageRecords = new SubagentMessagesRepo(dataDb.sqlite);
  const sessionRunning = new SessionRunningRegistry();
  const session = new SessionStore({
    db: dataDb,
    // Session 删除提交后清理库外文件(音频, 附件, 工具结果, scratchpad).
    onSessionRemoved: sessionId => removeSessionFiles(activeDataDir, sessionId),
    onChanged: emitChanged,
    isWorkClosed: sessionId => sessionRunning.isClosed(sessionId),
  });
  // 导入可能在文件已落位, SQL 尚未提交时退出; 开始接收请求前清理这些残留.
  const orphanDirs = removeOrphanSessionDirectories(activeDataDir, id => session.sessionExists(id));
  if (orphanDirs > 0) {
    console.warn(`[attachments] 清理 ${orphanDirs} 个无 Session 行的残留目录`);
  }
  const turns = new TurnStore({
    db: dataDb,
    onTurnRemoved: (sessionId, turnId) => {
      try {
        removeTurnFiles(activeDataDir, sessionId, turnId);
      } finally {
        emitChanged({ type: 'session_messages_changed', sessionId });
        emitChanged({ type: 'session_list_changed', sessionId });
      }
    },
    sessionRunning,
  });

  const attachmentImages = new AttachmentImagesRepo(dataDb.sqlite);
  const attachmentPastedTexts = new AttachmentPastedTextsRepo(dataDb.sqlite);
  const imageStore = new ImageStore(attachmentImages, activeDataDir, emitChanged);
  const pasteStore = new PastedTextStore(attachmentPastedTexts, activeDataDir, emitChanged);

  return {
    profileDb,
    dataDb,
    narrativeDb,
    activeDataDir,
    session,
    turns,
    sessionRunning,
    attachments: new AttachmentStore({ imageStore, pasteStore }),
    imageStore,
    pasteStore,
    attachmentImages,
    attachmentPastedTexts,
    tasks: new TaskStore(new TasksRepo(dataDb.sqlite), emitChanged),
    goals: new GoalStore(dataDb, emitChanged, sessionId => sessionRunning.isClosed(sessionId)),
    subagents: new SubagentStore(dataDb.sqlite, new SubagentsRepo(dataDb.sqlite), new SubagentRunsRepo(dataDb.sqlite)),
    subagentMessages: new SubagentMessagesStore(subagentMessageRecords),
    usageRecorder,
    messages,
    subagentMessageRecords,
    toolExecutions: new ToolExecutionsRepo(dataDb.sqlite),
    speechOutputs: new SpeechOutputsRepo(dataDb.sqlite),
    dataDirStats: new DataDirStatsRepo(dataDb.sqlite),
    sessionStats: new SessionStatsRepo(dataDb.sqlite),
    close() {
      narrativeDb.close();
      dataDb.close();
      profileDb.close();
    },
  };
}
