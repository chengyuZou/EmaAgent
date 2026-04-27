import { describe, it, expect, beforeEach } from "vitest";
import type {
  ChatMessage,
  CreateSessionInput,
  CreateTurnInput,
  ListMessagesOptions,
  ListTurnsOptions,
  MessagePage,
  SessionRepository,
  SessionState,
  SessionTitleStatus,
  TurnPage,
  TurnRepository,
  TurnRecord,
  UpdateTurnInput,
} from "@ema-agent/core-types";
import { bindSessionRepository, getSessionRepository } from "./session-repo.js";
import { getOrCreateSession, getSessionMessages } from "./session-service.js";

/** Mock 内存仓储 */
class MockSessionRepo implements SessionRepository, TurnRepository {
  private store = new Map<string, SessionState>();
  private turns = new Map<string, TurnRecord>();

  async getById(sessionId: string): Promise<SessionState | null> {
    return this.store.get(sessionId) ?? null;
  }

  async create(input: CreateSessionInput): Promise<SessionState> {
    const now = input.createdAt ?? Date.now();
    const session: SessionState = {
      id: input.id,
      title: input.title ?? "New Chat",
      messages: [],
      createdAt: now,
      updatedAt: now,
      fullAccess: false,
      activeSkills: [],
      titleStatus: "default",
      modeLast: input.modeLast ?? "chat",
      mode: input.modeLast ?? "chat",
    };
    await this.save(session);
    return session;
  }

  async save(session: SessionState): Promise<void> {
    this.store.set(session.id, { ...session });
  }

  async list(): Promise<{ id: string; title: string; modeLast: "chat"; messageCount: number; updatedAt: number }[]> {
    return Array.from(this.store.values()).map((s) => ({
      id: s.id,
      title: s.title,
      modeLast: "chat",
      messageCount: s.messages.length,
      updatedAt: s.updatedAt,
    }));
  }

  async listMessages(sessionId: string, options: ListMessagesOptions = {}): Promise<MessagePage> {
    const session = this.store.get(sessionId);
    const limit = options.limit ?? 50;
    const messages = (session?.messages ?? [])
      .filter((msg) => options.includeSystem || msg.role !== "system")
      .filter((msg) => options.includeTool || msg.role !== "tool")
      .slice(-limit);

    return {
      items: messages,
      hasMore: false,
    };
  }

  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.messages.push(message);
    session.updatedAt = Date.now();
    await this.save(session);
  }

  async updateTitle(sessionId: string, title: string, status: SessionTitleStatus = "manual"): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;
    session.title = title;
    session.titleStatus = status;
    session.titleUpdatedAt = Date.now();
    await this.save(session);
  }

  async updateModeLast(sessionId: string, mode: "chat" | "agent" | "narrative"): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;
    session.modeLast = mode;
    session.mode = mode;
    await this.save(session);
  }

  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }

  async createTurn(input: CreateTurnInput): Promise<TurnRecord> {
    const turn: TurnRecord = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      mode: input.mode,
      status: input.status ?? "running",
      modelId: input.modelId,
      providerId: input.providerId,
      startedAt: input.startedAt ?? Date.now(),
    };
    this.turns.set(turn.requestId, turn);
    return turn;
  }

  async getTurnById(requestId: string): Promise<TurnRecord | null> {
    return this.turns.get(requestId) ?? null;
  }

  async updateTurn(input: UpdateTurnInput): Promise<void> {
    const existing = this.turns.get(input.requestId);
    if (!existing) {
      throw new Error(`Turn not found: ${input.requestId}`);
    }
    this.turns.set(input.requestId, {
      ...existing,
      ...input,
      status: input.status ?? existing.status,
    });
  }

  async listTurnsBySession(sessionId: string, _options: ListTurnsOptions = {}): Promise<TurnPage> {
    return {
      items: Array.from(this.turns.values()).filter((turn) => turn.sessionId === sessionId),
      hasMore: false,
    };
  }
}

// 每个测试前重置 repo
describe("session-service", () => {
  beforeEach(() => {
    bindSessionRepository(new MockSessionRepo());
  });

  describe("getOrCreateSession", () => {
    it("should create a new session when not exists", async () => {
      const session = await getOrCreateSession("test-1");
      expect(session.id).toBe("test-1");
      expect(session.title).toBe("New Chat");
      expect(session.messages).toEqual([]);
    });

    it("should return existing session when already created", async () => {
      const first = await getOrCreateSession("test-2");
      const second = await getOrCreateSession("test-2");
      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
    });
  });

  describe("getSessionMessages", () => {
    it("should filter out system messages by default", async () => {
      // 先创建会话
      await getOrCreateSession("filter-test");
      
      // 手动通过 repo 加几条消息
      const repo = getSessionRepository();
      const session = await repo.getById("filter-test");
      if (!session) {
        throw new Error("测试会话创建失败");
      }
      session.messages = [
        { id: "1", role: "system", content: "system msg", createdAt: 1 },
        { id: "2", role: "user", content: "user msg", createdAt: 2 },
        { id: "3", role: "assistant", content: "assistant msg", createdAt: 3 },
      ] as ChatMessage[];
      await repo.save(session);

      const msgs = await getSessionMessages("filter-test");
      expect(msgs.length).toBe(2);
      expect(msgs.every((m) => m.role !== "system")).toBe(true);
    });

    it("should respect limit option", async () => {
      await getOrCreateSession("limit-test");
      const repo = getSessionRepository();
      const session = await repo.getById("limit-test");
      if (!session) {
        throw new Error("测试会话创建失败");
      }
      session.messages = Array.from({ length: 10 }, (_, i) => ({
        id: String(i),
        role: "user",
        content: `msg ${i}`,
        createdAt: i,
      })) as ChatMessage[];
      await repo.save(session);

      const msgs = await getSessionMessages("limit-test", { limit: 3 });
      expect(msgs.length).toBe(3);
      expect(msgs[0].content).toBe("msg 7"); // 取最后 3 条：7, 8, 9
      expect(msgs[2].content).toBe("msg 9");
    });
  });
});
