// 集中管理 Session、项目与消息读写的领域规则：什么能写、怎么写、写完联动什么。
// Turn 生命周期、运行态与导航由 turn 包的 TurnStore 承担；本包只经 storage repo 读取归属。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MessagesRepo,
  ProjectsRepo,
  SessionsRepo,
  TurnsRepo,
  type MessagePageCursor,
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
  ProjectFolder,
  CreateSessionInput,
  PatchSessionInput,
  AppendMessageInput,
  ListMessagesInput,
  ListMessagesAroundInput,
  MessagePage,
  MessageWindow,
  PersistedToolInteraction,
  SearchSessionsInput,
  SearchSessionsOutput,
  MoveSessionInSidebarInput,
  MoveProjectInSidebarInput,
} from './types.js';
import type { MessageBlocks } from './message.js';
import type { SessionEvent } from './events.js';

// ── Session 聚合 ─────────────────────────────────────────────────────────────

/** 新会话默认标题；自动标题生成只覆盖这个值（用户改名后以用户为准）。 */
export const DEFAULT_SESSION_TITLE = '新对话';

export interface SessionStoreDeps {
  db: Database;
  /** Session 删除后清理数据库外的音频、附件和工具结果文件。 */
  onSessionRemoved?: (sessionId: string) => void;
  onChanged?: (event: SessionEvent) => void;
}

/** 管理 Session/Project/Message 聚合的规则与读写。 */
export class SessionStore {
  private readonly sessionsRepo: SessionsRepo;
  private readonly turnsRepo:    TurnsRepo;
  private readonly messagesRepo: MessagesRepo;
  private readonly projectsRepo: ProjectsRepo;
  private readonly db:           Database;
  private readonly onSessionRemoved?: (sessionId: string) => void;
  private readonly onChanged?: (event: SessionEvent) => void;
  /** 单调时间戳避免同毫秒写入破坏游标边界。 */
  private lastTs = 0;

  constructor({ db, onSessionRemoved, onChanged }: SessionStoreDeps) {
    this.sessionsRepo = new SessionsRepo(db.sqlite);
    this.turnsRepo    = new TurnsRepo(db.sqlite);
    this.messagesRepo = new MessagesRepo(db.sqlite);
    this.projectsRepo = new ProjectsRepo(db.sqlite);
    this.db           = db;
    this.onSessionRemoved = onSessionRemoved;
    this.onChanged = onChanged;
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
    const title = (input.title?.trim() || DEFAULT_SESSION_TITLE);
    if (input.cwd !== undefined && input.cwd.trim() === '') {
      throw new Error('session_cwd_invalid');
    }

    this.db.sqlite.transaction(() => {
      let cwd = input.cwd;
      if (input.projectId !== undefined) {
        if (!this.projectsRepo.findById(input.projectId)) {
          throw new Error(`project_not_found: ${input.projectId}`);
        }
        cwd ??= this.projectsRepo.primaryFolderPath(input.projectId);
      }
      if (!cwd) {
        cwd = path.join(os.homedir(), '.ema-agent', 'workspace');
        fs.mkdirSync(cwd, { recursive: true });
      }
      assertSessionCwd(cwd);
      this.sessionsRepo.insert({
        id,
        title,
        cwd,
        projectId: input.projectId,
        executionProfile: input.executionProfile,
        narrativePolicy: input.narrativePolicy,
        permissionMode: input.permissionMode,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      });
    })();
    const session = this.requireSession(id);
    this.onChanged?.({ type: 'session_list_changed' });
    return session;
  }

  getSession(id: string): Session {
    return this.requireSession(id);
  }

  /** 无异常检查，供调用方识别删库后残留的客户端 Session ID。 */
  sessionExists(id: string): boolean {
    return this.sessionsRepo.findById(id) !== undefined;
  }

  /** 侧栏投影：置顶 Session / 置顶项目 / 其余项目 / 最近 / 已归档。 */
  listSessionsForSidebar(): {
    pinned:   SessionListItem[];
    pinnedProjects: Project[];
    projects: Project[];
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

    const pinnedProjects: Project[] = [];
    const projects: Project[] = [];
    for (const projectRow of this.projectsRepo.list()) {
      const project = toProject(
        projectRow,
        foldersByProject.get(projectRow.id) ?? [],
        (membersByProject.get(projectRow.id) ?? []).map(toSessionListItem),
      );
      if (project.pinned) pinnedProjects.push(project);
      else projects.push(project);
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
    this.onChanged?.({ type: 'session_list_changed' });
  }

  updateTitle(id: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    this.sessionsRepo.updateTitle(id, trimmed, Date.now());
    this.onChanged?.({ type: 'session_list_changed' });
  }

  /** 自动标题的条件写入：用户已改名（或会话已删）时返回 false，调用方不得发变更事件。 */
  updateTitleIfDefault(id: string, title: string): boolean {
    const trimmed = title.trim();
    if (!trimmed) return false;
    const changed = this.sessionsRepo.updateTitleIfDefault(id, trimmed, DEFAULT_SESSION_TITLE, Date.now());
    if (changed) this.onChanged?.({ type: 'session_list_changed' });
    return changed;
  }

  /**
   * 在一个事务内更新 Session 偏好。
   * cwd 是每条 Session 自己的执行目录；项目文件夹变化不回写它。
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
    if (patch.cwd !== undefined) {
      assertSessionCwd(patch.cwd);
      cleaned.cwd = patch.cwd;
    }
    if (patch.executionProfile !== undefined) cleaned.executionProfile = patch.executionProfile;
    if (patch.narrativePolicy !== undefined) cleaned.narrativePolicy = patch.narrativePolicy;
    if (patch.permissionMode !== undefined) cleaned.permissionMode = patch.permissionMode;
    if (patch.model !== undefined) {
      cleaned.model = patch.model;
    }

    if (Object.keys(cleaned).length === 0) return;

    this.sessionsRepo.patch(id, cleaned, Date.now());
    this.onChanged?.({ type: 'session_list_changed' });
  }

  // ── 置顶 ───────────────────────────────────────────────────────────────────

  pinSession(id: string): void {
    this.sessionsRepo.pin(id, Date.now());
    this.onChanged?.({ type: 'session_list_changed' });
  }

  unpinSession(id: string): void {
    this.sessionsRepo.unpin(id);
    this.onChanged?.({ type: 'session_list_changed' });
  }

  // ── 归档 ───────────────────────────────────────────────────────────────────

  archiveSession(id: string): void {
    this.sessionsRepo.archive(id, Date.now());
    this.onChanged?.({ type: 'session_list_changed' });
  }

  unarchiveSession(id: string): void {
    this.sessionsRepo.unarchive(id);
    this.onChanged?.({ type: 'session_list_changed' });
  }

  // ── 项目 ────────────────────────────────────────────────────────────────────

  listProjectFolders(projectId: string): ProjectFolder[] {
    if (!this.projectsRepo.findById(projectId)) {
      throw new Error(`project_not_found: ${projectId}`);
    }
    return this.projectsRepo.listFolders(projectId).map(toProjectFolder);
  }

  createProject(
    name: string,
    folderPaths: string[],
    primaryFolderPath?: string,
  ): Project {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('project_name_empty');
    const paths = folderPaths.map((path) => path.trim());
    const primaryPath = primaryFolderPath?.trim();
    if (paths.some((path) => !path)) {
      throw new Error('project_folder_path_empty');
    }
    if (primaryPath !== undefined && !paths.includes(primaryPath)) {
      throw new Error('project_primary_folder_missing');
    }
    if (new Set(paths).size !== paths.length) {
      throw new Error('project_folder_duplicate');
    }
    const id = crypto.randomUUID();
    this.db.sqlite.transaction(() => {
      this.projectsRepo.insert({ id, name: trimmed, now: Date.now() });
      for (const path of paths) {
        this.projectsRepo.addFolder(id, path);
      }
      if (primaryPath && paths[0] !== primaryPath) {
        this.projectsRepo.setPrimaryFolder(id, primaryPath);
      }
    })();
    const project = toProject(
      this.projectsRepo.findById(id)!,
      this.projectsRepo.listFolders(id).map(toProjectFolder),
      [],
    );
    this.onChanged?.({ type: 'session_list_changed' });
    return project;
  }

  renameProject(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.projectsRepo.rename(id, trimmed, Date.now());
    this.onChanged?.({ type: 'session_list_changed' });
  }

  /** 删除项目：成员 Session 由外键 SET NULL 掉到非项目区，cwd 保留。 */
  deleteProject(id: string): void {
    this.projectsRepo.remove(id);
    this.onChanged?.({ type: 'session_list_changed' });
  }

  pinProject(id: string, pinned: boolean): void {
    this.projectsRepo.setPinned(id, pinned, Date.now());
    this.onChanged?.({ type: 'session_list_changed' });
  }

  moveProjectInSidebar(input: MoveProjectInSidebarInput): void {
    this.projectsRepo.moveInSidebar(
      input.projectId,
      input.section === 'pinned',
      input.beforeProjectId,
      Date.now(),
    );
    this.onChanged?.({ type: 'session_list_changed' });
  }

  addProjectFolder(projectId: string, path: string): void {
    this.projectsRepo.addFolder(projectId, path);
    this.onChanged?.({ type: 'session_list_changed' });
  }

  /** 移除文件夹只更新项目清单；已有 Session 的 cwd 是自己的历史选择。 */
  removeProjectFolder(projectId: string, path: string): void {
    this.projectsRepo.removeFolder(projectId, path);
    this.onChanged?.({ type: 'session_list_changed' });
  }

  /** 更换主文件夹只影响未来新建 Session 的初始 cwd。 */
  setProjectPrimaryFolder(projectId: string, path: string): void {
    this.projectsRepo.setPrimaryFolder(projectId, path);
    this.onChanged?.({ type: 'session_list_changed' });
  }

  /**
   * 拖入项目只改成员资格，不把原 cwd 加入项目文件夹清单。
   */
  assignSessionToProject(
    sessionId: string,
    projectId: string,
  ): void {
    this.requireSession(sessionId);
    if (!this.projectsRepo.findById(projectId)) {
      throw new Error(`project_not_found: ${projectId}`);
    }
    this.sessionsRepo.assignToProject(sessionId, projectId, Date.now());
    this.onChanged?.({ type: 'session_list_changed' });
  }

  /** 拖出项目：解除成员资格，cwd 保留原值恢复自由。 */
  removeSessionFromProject(sessionId: string): void {
    this.sessionsRepo.removeFromProject(sessionId, Date.now());
    this.onChanged?.({ type: 'session_list_changed' });
  }

  moveSessionInSidebar(input: MoveSessionInSidebarInput): void {
    let pinned = false;
    let projectId: string | null = null;
    if (input.destination.section === 'pinned') {
      pinned = true;
    } else if (input.destination.section === 'project') {
      projectId = input.destination.projectId;
      if (!this.projectsRepo.findById(projectId)) {
        throw new Error(`project_not_found: ${projectId}`);
      }
    }

    this.sessionsRepo.moveInSidebar(
      input.sessionId,
      pinned,
      projectId,
      input.beforeSessionId,
      Date.now(),
    );
    this.onChanged?.({ type: 'session_list_changed' });
  }

  // ── 独立 Session Fork ──────────────────────────────────────────────────────

  /**
   * 创建独立 Session 副本；`untilTurnId` 为空时完整复制，否则复制到该 Turn（含）。
   * 新 Session 重新生成 Turn 与 Message ID；附件块按原 path 引用源 Session 的
   * 受管文件。不继承 Task、AgentRun 或正在运行的外部副作用。
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
    this.onChanged?.({ type: 'session_list_changed' });
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
    try {
      this.onSessionRemoved?.(id);
    } finally {
      this.onChanged?.({ type: 'session_list_changed' });
    }
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
    const message = this.requireMessage(id);
    this.onChanged?.({ type: 'session_messages_changed', sessionId: input.sessionId });
    return message;
  }

  /**
   * 写入 Session 级压缩摘要（turnId=null、kind='summary'）。
   * summarizedThroughMessageId 是覆盖截止游标：摘要包含该消息在内的全部既有有效历史，
   * loadHistory 按该消息位置切边界。游标必须属于本 Session，拒绝悬挂引用。
   */
  appendHistorySummary(input: {
    sessionId: string;
    summary: string;
    summarizedThroughMessageId: string;
  }): Message {
    const through = this.messagesRepo.findById(input.summarizedThroughMessageId);
    if (!through || through.session_id !== input.sessionId) {
      throw new Error(
        `summary_through_message_not_in_session: ${input.summarizedThroughMessageId}`,
      );
    }
    const id = crypto.randomUUID();
    this.messagesRepo.insert({
      id,
      sessionId: input.sessionId,
      role: 'user',
      kind: 'summary',
      blocksJson: JSON.stringify(input.summary),
      createdAt: this.nextTs(),
      summarizedThroughMessageId: input.summarizedThroughMessageId,
    });
    const message = this.requireMessage(id);
    this.onChanged?.({ type: 'session_messages_changed', sessionId: input.sessionId });
    return message;
  }

  markMessageInterrupted(id: string): void {
    const message = this.requireMessage(id);
    this.messagesRepo.markInterrupted(id);
    this.onChanged?.({ type: 'session_messages_changed', sessionId: message.sessionId });
  }

  /**
   * 流式落库的 block 级更新口：调用方持有 messageId，整体替换 blocks。
   * 序列化在业务层，storage 只收 JSON 串（与 appendMessage 分工一致）。
   * 消息不存在时抛错，防止流式续写写进已删消息而静默丢失。
   */
  updateMessageBlocks(messageId: string, blocks: MessageBlocks): void {
    const changed = this.messagesRepo.updateBlocks(
      messageId,
      JSON.stringify(blocks),
    );
    if (changed === 0) throw new Error(`message_not_found: ${messageId}`);
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

  /** UI 正文分页：返回旧到新的一页，游标只允许原样回传。 */
  listMessages(sessionId: string, input: ListMessagesInput = {}): MessagePage {
    const limit = messageReadLimit(input.limit, MESSAGE_PAGE_DEFAULT_LIMIT, 'message_page_limit');
    this.requireSession(sessionId);
    // UI 正文分页固定从新往旧取再 reverse 成旧到新展示;排序方向不受存储页查看器影响。
    const page = this.messagesRepo.listPage(
      sessionId,
      input.before ? decodeMessageCursor(input.before) : undefined,
      limit,
      'desc',
    );
    return {
      messages: [...page.rows].reverse().map(toMessage),
      ...(page.nextCursor ? { olderCursor: encodeMessageCursor(page.nextCursor) } : {}),
    };
  }

  /** UI 跳转：按 Message 身份读取锚点两侧，不把 History 重新按 Turn 分页。 */
  listMessagesAround(
    sessionId: string,
    input: ListMessagesAroundInput,
  ): MessageWindow {
    this.requireSession(sessionId);
    this.assertMessageOwnership(sessionId, input.anchorMessageId);
    const before = messageReadLimit(input.before, MESSAGE_WINDOW_DEFAULT_BEFORE, 'message_window_before', true);
    const after = messageReadLimit(input.after, MESSAGE_WINDOW_DEFAULT_AFTER, 'message_window_after', true);
    if (before + after > MESSAGE_WINDOW_MAX_TOTAL) throw new Error('message_window_too_large');
    const window = this.messagesRepo.listWindowAround(
      sessionId,
      input.anchorMessageId,
      before,
      after,
    );
    if (!window) throw new Error(`message_not_found: ${input.anchorMessageId}`);
    return {
      messages: window.rows.map(toMessage),
      hasOlder: window.hasOlder,
      hasNewer: window.hasNewer,
    };
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
const MESSAGE_PAGE_DEFAULT_LIMIT = 50;
const MESSAGE_PAGE_MAX_LIMIT = 200;
const MESSAGE_WINDOW_DEFAULT_BEFORE = 20;
const MESSAGE_WINDOW_DEFAULT_AFTER = 30;
const MESSAGE_WINDOW_MAX_TOTAL = 100;

function assertSessionCwd(cwd: string): void {
  if (!path.isAbsolute(cwd)) throw new Error('session_cwd_invalid');
}

function messageReadLimit(
  value: number | undefined,
  defaultValue: number,
  errorCode: string,
  allowZero = false,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < (allowZero ? 0 : 1) || resolved > MESSAGE_PAGE_MAX_LIMIT) {
    throw new RangeError(errorCode);
  }
  return resolved;
}

function encodeMessageCursor(cursor: MessagePageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeMessageCursor(value: string): MessagePageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object'
      && parsed !== null
      && 'createdAt' in parsed
      && Number.isSafeInteger(parsed.createdAt)
      && 'id' in parsed
      && typeof parsed.id === 'string'
      && parsed.id.length > 0
    ) {
      return { createdAt: parsed.createdAt as number, id: parsed.id };
    }
  } catch {
    // 外部游标不是本服务生成的值。
  }
  throw new Error('invalid_message_cursor');
}
