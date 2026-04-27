import type { ChatMessage, MessagePage } from "@ema-agent/core-types";

const API_BASE_URL = "http://127.0.0.1:3000";

export async function loadSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  const response = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/messages?limit=100`);

  if (!response.ok) {
    throw new Error(`Failed to load messages: ${response.status}`);
  }

  const page = (await response.json()) as MessagePage;
  return page.items;
}
