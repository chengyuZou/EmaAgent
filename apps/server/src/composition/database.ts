// 持久化一族：profile/data 两个 Database 的打开、迁移与全部存储层 Store 构造。
import {
  AgentRunMessagesRepo,
  AgentRunsRepo,
  MessagesRepo,
  AttachmentImagesRepo,
  AttachmentPastedTextsRepo,
  Database,
  DataDirStatsRepo,
  SessionStatsRepo,
  TasksRepo,
  UsageRecordsRepo,
} from '@ema-agent/storage';
import { AgentRunMessagesStore, AgentRunStore, type AgentRunChangedEvent } from '@ema-agent/agent';
import { AttachmentStore, ImageStore, PastedTextStore, type AttachmentEvent } from '@ema-agent/attachments';
import { ActiveSessionRegistry, SessionStore, type SessionEvent } from '@ema-agent/session';
import { TaskStore, type TaskEvent } from '@ema-agent/tasks';
import { TurnStore } from '@ema-agent/turn';
import type { UsageEvent, UsageRecorder } from '@ema-agent/usage';
import {
  dataDbPathFor,
  profileDbPath,
  removeOrphanSessionDirectories,
  removeSessionDir,
  removeTurnFiles,
} from '../platform/paths.js';

export interface DatabaseComposition {
  /** `~/.ema-agent/profile.db`：Provider 配置、模型绑定、角色卡、设置。跨数据目录共享。 */
  readonly profileDb: Database;
  /** `{activeDataDir}/data.db`：Session/Turn/Message/附件/后台进程。 */
  readonly dataDb: Database;
  /** 当前活动数据目录绝对路径；文件类存储（附件、音频、后台日志）都落在它下面。 */
  readonly activeDataDir: string;

  readonly session: SessionStore;
  readonly turns: TurnStore;
  /** Session 级活跃执行坑位：根 Turn 与手动 compact 共享互斥（commands 装配同源注入）。 */
  readonly activeSessions: ActiveSessionRegistry;
  readonly attachments: AttachmentStore;
  /** 粘贴端点直接调用;attachmentStore 内部共享同一实例。 */
  readonly imageStore: ImageStore;
  readonly pasteStore: PastedTextStore;
  /** 附件页路由直接查询的两本账。 */
  readonly attachmentImages: AttachmentImagesRepo;
  readonly attachmentPastedTexts: AttachmentPastedTextsRepo;
  readonly tasks: TaskStore;
  readonly agentRuns: AgentRunStore;
  readonly agentRunMessages: AgentRunMessagesStore;
  /** 全部能力调用共享的记账口；SQL 写入成功后通知用量视图。 */
  readonly usageRecorder: UsageRecorder;
  /** 用量明细查询的 SQL Repo，供 Token 明细页读取。 */
  readonly usageRecords: UsageRecordsRepo;
  /** raw 消息只读投影(存储页消息查看器)。 */
  readonly messages: MessagesRepo;
  /** 数据目录/单 Session 的存储统计只读投影。 */
  readonly dataDirStats: DataDirStatsRepo;
  readonly sessionStats: SessionStatsRepo;

  /** 关闭两个数据库；进程关闭序列的最后一步。 */
  close(): void;
}

/**
 * 打开并迁移两个数据库，构造全部存储层 Store。
 * activeDataDir 由 lifecycle 经 profile.db 的 data_dirs 表决议后传入——本函数不决定"用哪个目录"。
 */
export function openDatabases(
  activeDataDir: string,
  emitChanged: (
    event: SessionEvent | AttachmentEvent | UsageEvent | AgentRunChangedEvent | TaskEvent,
  ) => void,
): DatabaseComposition {
  const profileDb = new Database({ path: profileDbPath(), kind: 'profile' });
  try {
    profileDb.migrate();
  } catch (err) {
    profileDb.close();
    throw err;
  }

  const dataDb = new Database({ path: dataDbPathFor(activeDataDir), kind: 'data' });
  try {
    dataDb.migrate();
  } catch (err) {
    dataDb.close();
    profileDb.close();
    throw err;
  }

  const usageRecords = new UsageRecordsRepo(dataDb.sqlite);
  const usageRecorder: UsageRecorder = {
    record(record) {
      usageRecords.record(record);
      emitChanged({ type: 'usage_recorded', sessionId: record.sessionId });
    },
  };
  const messages = new MessagesRepo(dataDb.sqlite);
  const session = new SessionStore({
    db: dataDb,
    // Session 删除提交后清理库外文件（音频、附件、工具结果、scratchpad）。
    onSessionRemoved: sessionId => removeSessionDir(activeDataDir, sessionId),
    onChanged: emitChanged,
  });
  // 启动对账:清掉导入崩溃留下的"有目录无行"尸体目录。
  const orphanDirs = removeOrphanSessionDirectories(activeDataDir, id => session.sessionExists(id));
  if (orphanDirs > 0) {
    console.warn(`[attachments] 清理 ${orphanDirs} 个无 Session 行的残留目录`);
  }
  const activeSessions = new ActiveSessionRegistry();
  const turns = new TurnStore({
    db: dataDb,
    onTurnRemoved: (sessionId, turnId) => {
      try {
        removeTurnFiles(activeDataDir, sessionId, turnId);
      } finally {
        emitChanged({ type: 'session_messages_changed', sessionId });
        emitChanged({ type: 'session_list_changed' });
      }
    },
    activeSessions,
  });

  const attachmentImages = new AttachmentImagesRepo(dataDb.sqlite);
  const attachmentPastedTexts = new AttachmentPastedTextsRepo(dataDb.sqlite);
  const imageStore = new ImageStore(attachmentImages, activeDataDir, emitChanged);
  const pasteStore = new PastedTextStore(attachmentPastedTexts, activeDataDir, emitChanged);

  return {
    profileDb,
    dataDb,
    activeDataDir,
    session,
    turns,
    activeSessions,
    attachments: new AttachmentStore({ imageStore, pasteStore }),
    imageStore,
    pasteStore,
    attachmentImages,
    attachmentPastedTexts,
    tasks: new TaskStore(new TasksRepo(dataDb.sqlite), emitChanged),
    agentRuns: new AgentRunStore(new AgentRunsRepo(dataDb.sqlite), emitChanged),
    agentRunMessages: new AgentRunMessagesStore(new AgentRunMessagesRepo(dataDb.sqlite)),
    usageRecorder,
    usageRecords,
    messages,
    dataDirStats: new DataDirStatsRepo(dataDb.sqlite),
    sessionStats: new SessionStatsRepo(dataDb.sqlite),
    close() {
      dataDb.close();
      profileDb.close();
    },
  };
}
