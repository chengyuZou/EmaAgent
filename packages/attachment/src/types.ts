import type { MessageContentPart, TurnAttachment } from '@ema-agent/contracts';

// ── Domain type ───────────────────────────────────────────────────────────────

/** Persisted attachment record — maps 1:1 to the turn_attachments table. */
export interface Attachment {
  id:        string;
  turnId:    string;
  sessionId: string;
  name:      string;
  mime:      string;
  size:      number;
  mtime:     number;   // unix ms — lets tools detect post-attach file changes
  localPath: string;
  createdAt: number;
}

/** What the turns route receives from the frontend. */
export type AttachmentInput = Required<Pick<TurnAttachment, 'id' | 'name' | 'mimeType' | 'size' | 'mtime' | 'localPath'>>;

// ── Resolver output ───────────────────────────────────────────────────────────

/**
 * Result of resolving a list of attachments for a single LLM turn.
 *
 * imageParts  — image/* files below the inline limit, base64-encoded.
 *               These go into the user message's content parts array,
 *               before the text.
 *
 * promptLines — all other attachments formatted as a text block to append
 *               at the end of the user message. Empty string when none.
 */
export interface ResolvedPrompt {
  imageParts:  MessageContentPart[];
  promptLines: string;
}

export type { TurnAttachment };
