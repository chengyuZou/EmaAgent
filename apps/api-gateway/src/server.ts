import { pathToFileURL } from "node:url";
import { EmaError, ErrorCode, isEmaError } from "@ema-agent/constants-core";
import {
  isEmaMode,
  toInternalUiError,
  type EmaMode,
  type EmaStreamEvent,
  type StartTurnRequest,
  type StartTurnResponse,
} from "@ema-agent/core-types";
import { aggregateStream, runTurn } from "@ema-agent/orchestrator-runtime";
import { bindSessionRepository, getOrCreateSession } from "@ema-agent/session-runtime";
import { createSqliteSessionRepository } from "@ema-agent/storage-sql";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { encodeNdjsonEvent, encodeSseComment, encodeSseEvent } from "./sse.js";
import { consumeTurnStream, registerTurnStream, removeTurnStream } from "./turn-stream-registry.js";

interface ChatRequestBody {
  sessionId: string;
  mode?: EmaMode;
  rawUserQuery: string;
}

/** 创建 API Gateway 时可注入的选项，方便测试和跨平台 app data 路径切换。 */
export interface CreateServerOptions {
  /** SQLite 数据库路径；测试可传 :memory:，桌面端后续传 Tauri app data 路径。 */
  databasePath?: string;
}

export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const sessionRepository = createSqliteSessionRepository({
    databasePath: options.databasePath ?? process.env.EMA_SQLITE_PATH,
  });
  bindSessionRepository(sessionRepository);

  const app = Fastify({
    logger: true,
    genReqId: () => crypto.randomUUID(),
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (isEmaError(error)) {
      const statusCode = error.code === ErrorCode.PARAM_INVALID ? 400 : 500;
      return reply.status(statusCode).send({
        code: error.code,
        message: error.message,
      });
    }

    return reply.status(500).send({
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/sessions", async () => sessionRepository.list());

  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      const session = await sessionRepository.getById(request.params.sessionId);
      if (!session) {
        return reply.status(404).send({
          code: "SESSION_NOT_FOUND",
          message: "Session not found.",
        });
      }
      return session;
    },
  );

  app.get<{
    Params: { sessionId: string };
    Querystring: { limit?: string; beforeCreatedAt?: string };
  }>("/api/sessions/:sessionId/messages", async (request) => {
    const page = await sessionRepository.listMessages(request.params.sessionId, {
      limit: request.query.limit ? Number(request.query.limit) : undefined,
      beforeCreatedAt: request.query.beforeCreatedAt ? Number(request.query.beforeCreatedAt) : undefined,
    });
    return page;
  });

  app.get<{ Params: { sessionId: string } }>(
    "/api/chat/sessions/:sessionId/messages",
    async (request) => {
      const session = await getOrCreateSession(request.params.sessionId);
      return session.messages;
    },
  );

  app.post<{ Body: StartTurnRequest }>("/api/turns", async (request): Promise<StartTurnResponse> => {
    const start = normalizeStartTurnRequest(request.body);
    const rawUserQuery = extractRawUserQuery(start);
    const acceptedAt = Date.now();
    const turn = await runTurn({
      sessionId: start.sessionId,
      mode: start.mode,
      rawUserQuery,
    });

    registerTurnStream({
      requestId: turn.requestId,
      sessionId: start.sessionId,
      acceptedAt,
      stream: turn.stream,
    });

    return {
      requestId: turn.requestId,
      sessionId: start.sessionId,
      acceptedAt,
      streamUrl: `/api/turns/${turn.requestId}/stream`,
    };
  });

  app.get<{ Params: { requestId: string } }>("/api/turns/:requestId/stream", async (request, reply) => {
    const entry = consumeTurnStream(request.params.requestId);
    if (!entry) {
      return reply.status(404).send({
        code: "TURN_STREAM_NOT_FOUND",
        message: "Turn stream not found or already consumed.",
      });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    reply.raw.write(encodeSseComment("ema-turn-stream-open"));

    try {
      for await (const item of aggregateStream(entry.stream)) {
        reply.raw.write(encodeSseEvent(item));
      }
    } catch (error) {
      reply.raw.write(encodeSseEvent({ seq: 999999, event: toErrorEvent(entry.requestId, error) }));
    } finally {
      removeTurnStream(entry.requestId);
      reply.raw.end();
    }
  });

  app.post<{ Params: { requestId: string }; Body: { reason?: string } }>(
    "/api/turns/:requestId/stop",
    async () => ({ ok: true }),
  );

  app.post<{ Params: { requestId: string }; Body: unknown }>("/api/turns/:requestId/confirm", async () => ({
    ok: true,
  }));

  app.post<{ Params: { requestId: string }; Body: { from?: "last_user" | "message_id" } }>(
    "/api/turns/:requestId/retry",
    async (_request, reply) =>
      reply.status(501).send({
        code: "NOT_IMPLEMENTED",
        message: "Retry will be wired after persisted turn input is implemented.",
      }),
  );

  app.post<{ Body: ChatRequestBody }>("/api/chat", async (request, reply) => {
    const { sessionId, rawUserQuery, mode = "chat" } = request.body;
    const turn = await runTurn({
      sessionId,
      mode,
      rawUserQuery,
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    try {
      for await (const item of aggregateStream(turn.stream)) {
        reply.raw.write(encodeNdjsonEvent(item.event));
      }
    } catch (error) {
      reply.raw.write(encodeNdjsonEvent(toErrorEvent(turn.requestId, error)));
    } finally {
      reply.raw.end();
    }
  });

  return app;
}

function normalizeStartTurnRequest(body: StartTurnRequest): StartTurnRequest {
  if (!body.sessionId) {
    throw new EmaError(ErrorCode.PARAM_INVALID, "sessionId is required.", false);
  }

  if (!isEmaMode(body.mode)) {
    throw new EmaError(ErrorCode.PARAM_INVALID, "mode must be chat, agent, or narrative.", false);
  }

  if ((!body.input || body.input.length === 0) && !body.rawUserQuery) {
    throw new EmaError(ErrorCode.PARAM_INVALID, "input or rawUserQuery is required.", false);
  }

  return body;
}

function extractRawUserQuery(request: StartTurnRequest): string {
  const text = request.input
    ?.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return text || request.rawUserQuery?.trim() || "";
}

export async function startServer(): Promise<void> {
  const app = await createServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "127.0.0.1" });
  app.log.info(`Gateway listening on http://127.0.0.1:${port}`);
}

function toErrorEvent(requestId: string, error: unknown): EmaStreamEvent {
  if (isEmaError(error)) {
    return {
      type: "turn_failed",
      requestId,
      error: {
        code: error.code === ErrorCode.PARAM_INVALID ? "bad_request" : "internal_error",
        message: error.message,
        retryable: error.retryable,
        severity: "error",
      },
      retryable: error.retryable,
    };
  }

  return {
    type: "turn_failed",
    requestId,
    error: toInternalUiError(error),
    retryable: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer();
}
