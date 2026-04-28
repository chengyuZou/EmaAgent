import { EmaMode } from "./modes";

// ==========================================
// 1. 消息体与块状渲染 (Blocks)
// ==========================================

export type MessageRole = "user" | "assistant" | "system" | "tool";

/** 
 * 消息正文块：彻底实现“一切皆区块”。
 * 前端 UI 渲染聊天流时，不需要去苦哈哈地自己正则拆字符串，
 * 只需按顺序将这些 block map 循环渲染成对应的卡片即可。
 */
export type MessageContentBlock =
    | { type: "text"; text: string }                                        // 纯文本、Markdown
    | { type: "image"; url: string; mimeType?: string; alt?: string }       // 【新增】：多模态图片（用户上传的，或从网图拉取的）
    | { type: "artifact_ref"; artifactId: string }                          // 指向我们上一轮定义的庞大产物 Artifacts 的快捷指针
    | { type: "tool_call"; toolCallId: string; toolName: string; args: Record<string, unknown> } // "正在使用本地文件搜索..."
    | { type: "tool_result"; toolCallId: string; toolName: string; success: boolean; resultStr: string; durationMs: number }; // "搜索完毕 耗时1.2s"

/** 消息在客户端可见 UI 的瞬时进度状态 */
export type MessageStatus = "sending" | "generating" | "complete" | "error";

/** 
 * 统一的消息体持久化中心单元。
 * 所有历史记录读写均用此最新类型。
 */
export interface ChatMessage {
    id: string;
    role: MessageRole;
    
    /** 
     * 强结构化的正文块。这是目前工业级界面的唯一基石！
     * 不再把所有乱七八糟的流程（搜文件、调 API）硬塞成纯字符串。
     */
    contentBlocks: MessageContentBlock[];
    
    /** 关联的 Turn (一次对话轮回) 请求 ID，便于日志追踪。 */
    requestId?: string;
    
    /** 界面展现使用的实时状态指示器。 */
    status: MessageStatus;
    
    /** 【错误溯源】：如果 status === "error" 呈现感叹号，这里标明为何报错。 */
    errorCode?: string;

    createdAt: number;
}

// ==========================================
// 2. 会话主表状态与游标分页
// ==========================================

/** 会话标题生命周期状态。 */
export type SessionTitleStatus = "default" | "pending" | "generated" | "fallback" | "manual" | "failed";

/** 
 * 数据库里存的一条完整的 Session (会话) 实体数据结构。
 */
export interface SessionState {
    id: string;
    title: string;
    messages: ChatMessage[];
    createdAt: number;
    updatedAt: number;
    /** 该模式最后一次成功走完 Turn 时所用的工作策略模式。供返回时恢复默认焦点用。 */
    modeLast: EmaMode;
    fullAccess: boolean;
    activeSkills: string[];
    titleStatus: SessionTitleStatus;
    titleUpdatedAt?: number;
}

export interface CreateSessionInput {
    id: string;
    title?: string;
    modeLast?: EmaMode;
    createdAt?: number;
}

export interface SessionSummary {
    id: string;
    title: string;
    messageCount: number;
    updatedAt: number;
    modeLast: EmaMode;
}

// ==========================================
// 3. 仓储层 (Repository) I/O 接口基座
// ==========================================

export interface ListMessagesOptions {
    /** 每次要取多数条数据 (防止瀑布流拉死) */
    limit?: number;
    /** 
     * 瀑布流之眼 (游标) 分页核心：传入在屏幕视口最顶头那条消息的 ID。
     * 表示：“去库里给我查把这个时间点以前的老消息”。
     */
    beforeMessageId?: string; 
    /** 是否包含繁冗且隐秘的 system persona 提示？(默认 false 免得瞎眼) */
    includeSystem?: boolean;
    /** 是否包含中间机器对话的 tool_calls？(有些轻量级客户端不用看) */
    includeTool?: boolean;
}

export interface MessagePage {
    items: ChatMessage[];
    /** 滑到底了吗？ */
    hasMore: boolean;
    /** 拿着这个 ID 当下一次的 `beforeMessageId` 就能接着往前翻。 */
    nextBeforeMessageId?: string; 
}

/** 
 * 标准化的依赖倒置接口！
 * 不纠结你是基于 SQLite 还是 JSON 文件写的后端，只要实现它就是合格的仓储。
 */
export interface SessionRepository {
    getById(sessionId: string): Promise<SessionState | null>;
    create(input: CreateSessionInput): Promise<SessionState>;
    save(session: SessionState): Promise<void>;
    list(): Promise<SessionSummary[]>;
    listMessages(sessionId: string, options?: ListMessagesOptions): Promise<MessagePage>;
    appendMessage(sessionId: string, message: ChatMessage): Promise<void>;
    updateTitle(sessionId: string, title: string, status?: SessionTitleStatus): Promise<void>;
    updateModeLast(sessionId: string, mode: EmaMode): Promise<void>;
    delete(sessionId: string): Promise<void>;
}
