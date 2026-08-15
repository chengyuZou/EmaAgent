// 集中管理 Session、项目与消息读写的领域规则：什么能写、怎么写、写完联动什么。
// Turn 生命周期、运行态与导航归 @ema-agent/turn 的 TurnStore；本包只经 storage repo 读取归属。
import crypto from 'node:crypto';
import {
  MessagesRepo,
  ProjectsRepo,
  SessionsRepo,
  TurnsRepo,
  type SessionRowEnriched,
} from '@ema-agent/storage';
import { SessionOwnershipError } from './errors.js';
import type { Database } from '@ema-agent/storage';
import {
  toMessage,
  toProject,
  toProjectFolder,
  toSearchHit,
  toSession,
  toSessionListItem,
} from './persistence/rowMapping.js';
import type {
  Session,
  SessionListItem,
  Message,
  Project,
  ProjectGroup,
  CreateSessionInput,
  PatchSessionInput,
  AppendMessageInput,
  ListMessagesInput,
  PersistedToolInteraction,
  SearchSessionsInput,
  SearchSessionsOutput,
} from './types.js';

// ── Session 聚合 ─────────────────────────────────────────────────────────────

export interface SessionStoreDeps {
  db: Database;
  /** Session 删除后清理数据库外的音频、附件和工具结果文件。 */
  onSessionRemoved?: (sessionId: string) => void;
}

/** 管理 Session/Project/Message 聚合的规则与读写。 */
export class SessionStore {
  private readonly sessionsRepo: SessionsRepo;
  private readonly turnsRepo:    TurnsRepo;
  private readonly messagesRepo: MessagesRepo;
  private readonly projectsRepo: ProjectsRepo;
  private readonly db:           Database;
  private readonly onSessionRemoved?: (sessionId: string) => void;
  /** 单调时间戳避免同毫秒写入破坏游标边界。 */
  private lastTs = 0;

  constructor({ db, onSessionRemoved }: SessionStoreDeps) {
    this.sessionsRepo = new SessionsRepo(db.sqlite);
    this.turnsRepo    = new TurnsRepo(db.sqlite);
    this.messagesRepo = new MessagesRepo(db.sqlite);
    this.projectsRepo = new ProjectsRepo(db.sqlite);
    this.db           = db;
    this.onSessionRemoved = onSessionRemoved;
  }

  // ── 内部时间 ────────────────────────────────────────────────────────────────

  /** 返回严格递增的进程内时间戳。 */
  private nextTs(): number {
    const now = Date.now();
    this.lastTs = now > this.lastTs ? now : this.lastTs + 1;
    return this.lastTs;
  }

  // ── Session ─────────────────────────────────────────────────────────────────

  createSession(input: CreateSessionInput = {}): Session {
    const id  = crypto.randomUUID();
    const now = this.nextTs();
    const title = (input.title?.trim() || '新对话');
    this.sessionsRepo.insert({
      id,
      title,
      workspaceRoot:    input.workspaceRoot,
      createdAt:        now,
      updatedAt:        now,
      lastActivityAt:   now,
    });
    return this.requireSession(id);
  }

  getSession(id: string): Session {
    return this.requireSession(id);
  }

  /** 无异常检查，供调用方识别删库后残留的客户端 Session ID。 */
  sessionExists(id: string): boolean {
    return this.sessionsRepo.findById(id) !== undefined;
  }

  /** 侧栏投影：置顶 Session / 置顶项目 / 其余项目 / 最近 / 已归档。 */
  listSessionsGrouped(): {
    pinned:   SessionListItem[];
    pinnedProjects: ProjectGroup[];
    projects: ProjectGroup[];
    recent:   SessionListItem[];
    archived: SessionListItem[];
  } {
    const all = this.sessionsRepo.listEnrichedAll();

    // 列出所有项目的文件夹 按 project_id 分组。
    const foldersByProject = new Map<string, ReturnType<typeof toProjectFolder>[]>();
    for (const folder of this.projectsRepo.listAllFolders()) {
      const list = foldersByProject.get(folder.project_id) ?? [];
      list.push(toProjectFolder(folder));
      foldersByProject.set(folder.project_id, list);
    }

    const membersByProject = new Map<string, SessionRowEnriched[]>();
    const pinned:   SessionListItem[] = [];
    const recent:   SessionListItem[] = [];
    const archived: SessionListItem[] = [];

    for (const row of all) {
      if (row.archived_at) { archived.push(toSessionListItem(row)); continue; }
      // 如果一个Session同时有project_id和pinned 则pin的优先级更高
      if (row.pinned) { pinned.push(toSessionListItem(row)); continue; }
      if (row.project_id) {
        const list = membersByProject.get(row.project_id) ?? [];
        list.push(row);
        membersByProject.set(row.project_id, list);
        continue;
      }
      recent.push(toSessionListItem(row));
    }

    const pinnedProjects: ProjectGroup[] = [];
    const projects: ProjectGroup[] = [];
    for (const projectRow of this.projectsRepo.list()) {
      const group: ProjectGroup = {
        project: toProject(projectRow),
        folders: foldersByProject.get(projectRow.id) ?? [],
        sessions: (membersByProject.get(projectRow.id) ?? []).map(toSessionListItem),
      };
      if (group.project.pinned) pinnedProjects.push(group);
      else projects.push(group);
    }

    return { pinned, pinnedProjects, projects, recent, archived };
  }

  searchSessions(input: SearchSessionsInput): SearchSessionsOutput {
    const query = input.query.trim();
    if (!query) return { results: [] };
    const rows = this.sessionsRepo.search(query, input.limit ?? 20);
    const results = rows.map(toSearchHit);
    return { results };
  }

  setViewedAt(id: string): void {
    this.sessionsRepo.setViewedAt(id, Date.now());
  }

  updateTitle(id: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    this.sessionsRepo.updateTitle(id, trimmed, Date.now());
  }

  /**
   * 在一个事务内更新 Session 偏好。
   * `workspaceRoot` 的 null 表示移出工作区，undefined 表示保持不变。
   */
  patchSession(
    id: string,
    patch: PatchSessionInput,
  ): void {
    const cleaned: Parameters<SessionsRepo['patch']>[1] = {};

    if (patch.title !== undefined) {
      const trimmed = patch.title.trim();
      if (trimmed) cleaned.title = trimmed;
    }
    if (patch.pinned !== undefined)     cleaned.pinned     = patch.pinned;
    if (patch.workspaceRoot !== undefined) {
      // 项目成员的工作区锁定为项目主文件夹，只能经项目操作变更。
      if (this.requireSession(id).projectId !== null) {
        throw new Error('session_workspace_locked_by_project');
      }
      cleaned.workspaceRoot = patch.workspaceRoot;
    }
    if (patch.executionProfile !== undefined) cleaned.executionProfile = patch.executionProfile;
    if (patch.narrativePolicy !== undefined) cleaned.narrativePolicy = patch.narrativePolicy;
    if (patch.model !== undefined) {
      cleaned.model = patch.model;
    }

    if (Object.keys(cleaned).length === 0) return;

    this.sessionsRepo.patch(id, cleaned, Date.now());
  }

  // ── 置顶 ───────────────────────────────────────────────────────────────────

  pinSession(id: string): void {
    this.sessionsRepo.pin(id, Date.now());
  }

  unpinSession(id: string): void {
    this.sessionsRepo.unpin(id);
  }

  // ── 归档 ───────────────────────────────────────────────────────────────────

  archiveSession(id: string): void {
    this.sessionsRepo.archive(id, Date.now());
  }

  unarchiveSession(id: string): void {
    this.sessionsRepo.unarchive(id);
  }

  // ── 项目 ────────────────────────────────────────────────────────────────────

  createProject(name: string, firstFolderPath?: string): Project {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('project_name_empty');
    const id = crypto.randomUUID();
    this.projectsRepo.insert({ id, name: trimmed, now: Date.now() });
    if (firstFolderPath) this.projectsRepo.addFolder(id, firstFolderPath);
    return toProject(this.projectsRepo.findById(id)!);
  }

  renameProject(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.projectsRepo.rename(id, trimmed, Date.now());
  }

  /** 删除项目：成员 Session 由外键 SET NULL 掉到非项目区，工作区保留恢复自由。 */
  deleteProject(id: string): void {
    this.projectsRepo.remove(id);
  }

  pinProject(id: string, pinned: boolean): void {
    this.projectsRepo.setPinned(id, pinned, Date.now());
  }

  addProjectFolder(projectId: string, path: string): void {
    this.projectsRepo.addFolder(projectId, path);
  }

  /** 移除文件夹；若触发主文件夹继位，同事务级联改写成员 workspace_root。 */
  removeProjectFolder(projectId: string, path: string): void {
    const { newPrimaryPath } = this.projectsRepo.removeFolder(projectId, path);
    if (newPrimaryPath !== null) {
      this.sessionsRepo.cascadeWorkspaceForProject(projectId, newPrimaryPath, Date.now());
    }
  }

  /** 更换主文件夹并级联全部成员。 */
  setProjectPrimaryFolder(projectId: string, path: string): void {
    this.projectsRepo.setPrimaryFolder(projectId, path);
    const primary = this.projectsRepo.primaryFolderPath(projectId);
    if (primary) this.sessionsRepo.cascadeWorkspaceForProject(projectId, primary, Date.now());
  }

  /**
   * 拖入项目：workspace_root 立即改写为项目主工作区并锁定。
   * `includeCurrentWorkspace` 为 true 且原工作区不在项目文件夹清单时，先把它加为
   * 非主文件夹（弹窗"是否加入原工作区"选确认的那条路径）。
   */
  assignSessionToProject(
    sessionId: string,
    projectId: string,
    includeCurrentWorkspace = false,
  ): void {
    const session = this.requireSession(sessionId);
    const primary = this.projectsRepo.primaryFolderPath(projectId);
    if (!primary) throw new Error(`project_has_no_folder: ${projectId}`);

    this.db.sqlite.transaction(() => {
      if (includeCurrentWorkspace && session.workspaceRoot) {
        const folders = this.projectsRepo.listFolders(projectId);
        if (!folders.some((folder) => folder.path === session.workspaceRoot)) {
          this.projectsRepo.addFolder(projectId, session.workspaceRoot);
        }
      }
      this.sessionsRepo.assignToProject(sessionId, projectId, primary, Date.now());
    })();
  }

  /** 拖出项目：解除成员资格，workspace_root 保留原值恢复自由。 */
  removeSessionFromProject(sessionId: string): void {
    this.sessionsRepo.removeFromProject(sessionId, Date.now());
  }

  // ── 独立 Session Fork ──────────────────────────────────────────────────────

  /**
   * 创建独立 Session 副本；`untilTurnId` 为空时完整复制，否则复制到该 Turn（含）。
   * 新 Session 重新生成 Turn、Message 与 Attachment ID，不继承 Task、
   * AgentRun 或正在运行的外部副作用。
   */
  forkSession(
    srcId:        string,
    untilTurnId?: string,
  ): { sessionId: string; messageCount: number } {
    const src   = this.requireSession(srcId);
    const newId = crypto.randomUUID();
    const title = `${src.title} (fork)`;
    const now   = this.nextTs();
    const messageCount = this.sessionsRepo.forkInto(srcId, newId, title, now, untilTurnId);
    return { sessionId: newId, messageCount };
  }

  // ── 删除 ───────────────────────────────────────────────────────────────────

  /**
   * 删除本聚合的数据库行并触发文件清理。活动 Turn 的取消与运行态收口
   * 归 TurnStore，由删除用例（Server 编排）先行调用。
   */
  deleteSession(id: string): void {
    this.sessionsRepo.delete(id);
    // 数据库行由外键级联；文件目录需要显式清理。
    this.onSessionRemoved?.(id);
  }

  // ── Message ─────────────────────────────────────────────────────────────────

  appendMessage(input: AppendMessageInput): Message {
    if (input.turnId) {
      const turn = this.turnsRepo.findById(input.turnId);
      if (!turn) throw new Error(`turn_not_found: ${input.turnId}`);
      if (turn.session_id !== (input.sessionId as string)) {
        throw new SessionOwnershipError(
          `turn ${input.turnId} belongs to session ${turn.session_id}, not ${input.sessionId}`,
        );
      }
    }
    const id  = crypto.randomUUID();
    const now = this.nextTs();
    const blocksJson = JSON.stringify(input.blocks);
    this.messagesRepo.insert({
      id,
      sessionId:   input.sessionId,
      turnId:      input.turnId ?? undefined,
      role:        input.role,
      kind:        input.kind ?? 'normal',
      blocksJson,
      interrupted: input.interrupted ?? false,
      createdAt:   now,
    });
    return this.requireMessage(id);
  }

  markMessageInterrupted(id: string): void {
    this.messagesRepo.markInterrupted(id);
  }

  /** 加载 LLM 可见历史；从最近 Summary 开始并保持时间正序。 */
  loadHistory(sessionId: string, limit = DEFAULT_HISTORY_LIMIT): Message[] {
    this.requireSession(sessionId);
    return this.messagesRepo.listForSessionFromSummary(sessionId, limit).map(toMessage);
  }

  /** 加载一个 Turn 的全部消息，供 Turn 后处理使用。 */
  loadMessagesForTurn(turnId: string): Message[] {
    return this.messagesRepo.listForTurn(turnId).map(toMessage);
  }

  /** 按 Turn 集合读取消息（时间正序），供 Turn 窗口在拼装层合成完整视图。 */
  listMessagesForTurns(sessionId: string, turnIds: readonly string[]): Message[] {
    this.requireSession(sessionId);
    return this.messagesRepo.listForTurns(sessionId, turnIds).map(toMessage);
  }

  /** 启动恢复按 Tool Call ID 找回模型原始调用与已经落库的结果。 */
  findToolInteraction(
    turnId: string,
    callId: string,
  ): PersistedToolInteraction | undefined {
    let interaction: PersistedToolInteraction | undefined;
    for (const message of this.loadMessagesForTurn(turnId)) {
      if (!Array.isArray(message.blocks)) continue;
      if (message.role === 'assistant') {
        const call = message.blocks.find(block => (
          typeof block === 'object'
          && block !== null
          && 'type' in block
          && block.type === 'tool_use'
          && block.id === callId
        ));
        if (call?.type === 'tool_use') {
          interaction = { name: call.name, args: call.args };
        }
        continue;
      }
      if (!interaction || message.kind !== 'tool_results') continue;
      const result = message.blocks.find(block => (
        typeof block === 'object'
        && block !== null
        && 'type' in block
        && block.type === 'tool_result'
        && block.toolCallId === callId
      ));
      if (result?.type === 'tool_result') interaction.result = result;
    }
    return interaction;
  }

  /** 兼容现有聊天页的时间游标读取，结果保持最新优先。 */
  listMessages(sessionId: string, input: ListMessagesInput = {}): Message[] {
    const limit = input.limit ?? 50;
    this.requireSession(sessionId);
    if (input.before === undefined) {
      return this.messagesRepo.listForSession(sessionId, limit).map(toMessage);
    }
    return this.messagesRepo.listBefore(sessionId, input.before, limit).map(toMessage);
  }

  /** 校验 message 属于指定 session；不向调用方暴露仓储。 */
  assertMessageOwnership(sessionId: string, messageId: string): void {
    const message = this.requireMessage(messageId);
    if (message.sessionId !== sessionId) {
      throw new SessionOwnershipError(
        `message ${messageId} belongs to session ${message.sessionId}, not ${sessionId}`,
      );
    }
  }

  // ── 归属读取 ────────────────────────────────────────────────────────────────

  private requireSession(id: string): Session {
    const row = this.sessionsRepo.findById(id);
    if (!row) throw new Error(`session_not_found: ${id}`);
    return toSession(row);
  }

  private requireMessage(id: string): Message {
    const row = this.messagesRepo.findById(id);
    if (!row) throw new Error(`message_not_found: ${id}`);
    return toMessage(row);
  }
}

const DEFAULT_HISTORY_LIMIT = 500;
