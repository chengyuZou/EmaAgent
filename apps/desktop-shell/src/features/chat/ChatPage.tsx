import {
  type Dispatch,
  type FormEvent,
  type JSX,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ChatMessage, EmaStreamEvent } from "@ema-agent/core-types";
import { useTurnStream } from "../turns/useTurnStream.js";
import { loadSessionMessages } from "./api.js";

type StreamMessage = ChatMessage & {
  requestId?: string;
  pending?: boolean;
};

const containerStyle = {
  minHeight: "100vh",
  background: "#0f172a",
  color: "#e2e8f0",
  display: "grid",
  placeItems: "center",
  padding: "24px",
  fontFamily: "Inter, system-ui, sans-serif",
} as const;

const panelStyle = {
  width: "min(920px, 100%)",
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: "16px",
  padding: "20px",
  display: "grid",
  gap: "16px",
} as const;

const listStyle = {
  minHeight: "360px",
  maxHeight: "60vh",
  overflow: "auto",
  display: "grid",
  gap: "12px",
} as const;

const textareaStyle = {
  width: "100%",
  minHeight: "100px",
  resize: "vertical" as const,
  borderRadius: "12px",
  padding: "12px",
  border: "1px solid #334155",
  background: "#020617",
  color: "#e2e8f0",
} as const;

export function ChatPage(): JSX.Element {
  const [sessionId] = useState(() => {
    const cached = window.localStorage.getItem("ema.sessionId");
    const nextId = cached ?? crypto.randomUUID();
    window.localStorage.setItem("ema.sessionId", nextId);
    return nextId;
  });
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const turnStream = useTurnStream();

  useEffect(() => {
    void refreshMessages(sessionId, setMessages, setErrorMessage);
  }, [sessionId]);

  const pendingCount = useMemo(
    () => messages.filter((message) => message.pending).length,
    [messages],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const rawUserQuery = input.trim();
    if (!rawUserQuery || isSending || turnStream.isStreaming) {
      return;
    }

    setErrorMessage(null);
    setIsSending(true);

    const optimisticUserMessage: StreamMessage = {
      id: `optimistic-user-${crypto.randomUUID()}`,
      role: "user",
      content: rawUserQuery,
      createdAt: Date.now(),
    };

    setMessages((current) => [...current, optimisticUserMessage]);
    setInput("");

    try {
      await turnStream.startTurn({
        sessionId,
        mode: "chat",
        input: [{ type: "text", text: rawUserQuery }],
      }, {
        onEvent(event) {
          handleStreamEvent(event, setMessages, setLastRequestId, setLastLatency, setErrorMessage);
        },
      });

      await refreshMessages(sessionId, setMessages, setErrorMessage);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to send message.");
      await refreshMessages(sessionId, setMessages, setErrorMessage);
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div style={containerStyle}>
      <div style={panelStyle}>
        <header>
          <h1 style={{ margin: 0, fontSize: "24px" }}>EmaAgent Minimal Loop</h1>
          <p style={{ margin: "8px 0 0", color: "#94a3b8" }}>
            Frontend input -&gt; `/api/chat` -&gt; `runTurn()` -&gt; SQLite -&gt; load back
          </p>
        </header>

        <section style={listStyle}>
          {messages.length === 0 ? (
            <div style={{ color: "#94a3b8" }}>No messages yet. Send one to start.</div>
          ) : (
            messages.map((message) => (
              <article
                key={message.id}
                style={{
                  padding: "12px",
                  borderRadius: "12px",
                  background: message.role === "user" ? "#1d4ed8" : "#1f2937",
                }}
              >
                <strong style={{ display: "block", marginBottom: "6px" }}>
                  {message.role === "user" ? "You" : "Ema"}
                  {message.pending ? " - streaming" : ""}
                </strong>
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{message.content}</div>
              </article>
            ))
          )}
        </section>

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: "12px" }}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Start with one small message."
            style={textareaStyle}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "#94a3b8" }}>Session: {sessionId}</span>
            <button
              type="submit"
              disabled={isSending || turnStream.isStreaming}
              style={{
                border: 0,
                borderRadius: "999px",
                padding: "10px 18px",
                cursor: isSending || turnStream.isStreaming ? "not-allowed" : "pointer",
                background: isSending || turnStream.isStreaming ? "#475569" : "#22c55e",
                color: "#020617",
                fontWeight: 700,
              }}
            >
              {isSending || turnStream.isStreaming ? "Sending..." : "Send"}
            </button>
          </div>
        </form>

        <footer style={{ color: "#94a3b8", display: "grid", gap: "6px" }}>
          <div>Pending streamed messages: {pendingCount}</div>
          <div>Last requestId: {lastRequestId ?? "-"}</div>
          <div>Last latency: {lastLatency === null ? "-" : `${lastLatency}ms`}</div>
          <div>Stream events: {turnStream.snapshot.steps.length} steps</div>
          {errorMessage ? <div style={{ color: "#fca5a5" }}>Error: {errorMessage}</div> : null}
        </footer>
      </div>
    </div>
  );
}

function handleStreamEvent(
  event: EmaStreamEvent,
  setMessages: Dispatch<SetStateAction<StreamMessage[]>>,
  setLastRequestId: Dispatch<SetStateAction<string | null>>,
  setLastLatency: Dispatch<SetStateAction<number | null>>,
  setErrorMessage: Dispatch<SetStateAction<string | null>>,
): void {
  if (event.type === "turn_started") {
    setLastRequestId(event.requestId);
    setLastLatency(null);
    return;
  }

  if (event.type === "output_text_delta") {
    setMessages((current) => upsertAssistantDraft(current, event.requestId, event.delta));
    return;
  }

  if (event.type === "turn_completed") {
    setLastLatency(Date.now() - event.at);
    setMessages((current) =>
      current.map((message) =>
        message.requestId === event.requestId ? { ...message, pending: false } : message,
      ),
    );
    return;
  }

  if (event.type === "turn_failed") {
    setErrorMessage(event.error.message);
    setMessages((current) =>
      current.map((message) =>
        message.requestId === event.requestId ? { ...message, pending: false } : message,
      ),
    );
  }
}

function upsertAssistantDraft(
  messages: StreamMessage[],
  requestId: string,
  chunk: string,
): StreamMessage[] {
  const index = messages.findIndex((message) => message.requestId === requestId);

  if (index === -1) {
    return [
      ...messages,
      {
        id: `assistant-${requestId}`,
        requestId,
        role: "assistant",
        content: chunk,
        createdAt: Date.now(),
        pending: true,
      },
    ];
  }

  return messages.map((message, currentIndex) =>
    currentIndex === index ? { ...message, content: `${message.content}${chunk}` } : message,
  );
}

async function refreshMessages(
  sessionId: string,
  setMessages: Dispatch<SetStateAction<StreamMessage[]>>,
  setErrorMessage: Dispatch<SetStateAction<string | null>>,
): Promise<void> {
  try {
    const storedMessages = await loadSessionMessages(sessionId);
    setMessages(storedMessages);
  } catch (error) {
    setErrorMessage(error instanceof Error ? error.message : "Failed to load history.");
  }
}
