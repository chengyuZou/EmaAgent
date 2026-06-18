import { randomUUID } from 'node:crypto';
import type { AttachmentRepo } from '@ema-agent/storage';
import type { Attachment, AttachmentInput, ResolvedPrompt } from './types.js';
import { AttachmentNotFoundError } from './errors.js';
import { resolveForPrompt } from './resolver.js';

// ── Per-turn limits (enforced server-side as a safety net) ────────────────────
const MAX_IMAGES_PER_TURN = 5;
const MAX_FILES_PER_TURN  = 10;

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IAttachmentStore {
  add(input: AttachmentInput, turnId: string, sessionId: string): Attachment;
  addAll(inputs: AttachmentInput[], turnId: string, sessionId: string): Attachment[];
  get(id: string): Attachment;
  listByTurn(turnId: string): Attachment[];
  listBySession(sessionId: string): Attachment[];
  remove(id: string): void;
  resolveForPrompt(attachments: Attachment[]): ResolvedPrompt;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class AttachmentStore implements IAttachmentStore {
  constructor(private readonly repo: AttachmentRepo) {}

  add(input: AttachmentInput, turnId: string, sessionId: string): Attachment {
    const att: Attachment = {
      id:        input.id ?? randomUUID(),
      turnId,
      sessionId,
      name:      input.name,
      mime:      input.mimeType,
      size:      input.size,
      mtime:     input.mtime,
      localPath: input.localPath,
      createdAt: Date.now(),
    };
    this.repo.insert({
      id:        att.id,
      turnId:    att.turnId,
      sessionId: att.sessionId,
      name:      att.name,
      mime:      att.mime,
      size:      att.size,
      mtime:     att.mtime,
      localPath: att.localPath,
      createdAt: att.createdAt,
    });
    return att;
  }

  addAll(inputs: AttachmentInput[], turnId: string, sessionId: string): Attachment[] {
    const images = inputs.filter(i => i.mimeType.startsWith('image/'));
    const files  = inputs.filter(i => !i.mimeType.startsWith('image/'));

    const safeImages = images.slice(0, MAX_IMAGES_PER_TURN);
    const safeFiles  = files.slice(0, MAX_FILES_PER_TURN);

    return [...safeImages, ...safeFiles].map(i => this.add(i, turnId, sessionId));
  }

  get(id: string): Attachment {
    const row = this.repo.findById(id);
    if (!row) throw new AttachmentNotFoundError(id);
    return rowToAttachment(row);
  }

  listByTurn(turnId: string): Attachment[] {
    return this.repo.listByTurn(turnId).map(rowToAttachment);
  }

  listBySession(sessionId: string): Attachment[] {
    return this.repo.listBySession(sessionId).map(rowToAttachment);
  }

  remove(id: string): void {
    this.repo.deleteById(id);
  }

  resolveForPrompt(attachments: Attachment[]): ResolvedPrompt {
    return resolveForPrompt(attachments);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToAttachment(row: {
  id: string; turn_id: string; session_id: string;
  name: string; mime: string; size: number; mtime: number;
  local_path: string; created_at: number;
}): Attachment {
  return {
    id:        row.id,
    turnId:    row.turn_id,
    sessionId: row.session_id,
    name:      row.name,
    mime:      row.mime,
    size:      row.size,
    mtime:     row.mtime,
    localPath: row.local_path,
    createdAt: row.created_at,
  };
}
