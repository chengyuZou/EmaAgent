// 定义尚未迁回业务所有者的跨端 REST JSON 数据结构。

// ── REST wire formats ─────────────────────────────────────────────────────────
//
// 仅保留尚未迁移的跨端结构；已明确所属业务的协议应回到对应模块。
//
// Rules:
//   - Backend routes annotate their response payloads with these types
//     (`satisfies` / return-type annotations) so a drifting field fails the
//     build on the producer side.
//   - Frontend api modules import these types directly — NEVER hand-copy
//     "matching" interfaces (two sources of truth always drift).
//   - Plain `string` here, not branded ids: wire types describe JSON, and
//     branded types (SessionId etc.) are assignable to string so producers
//     type-check without casts. Consumers re-brand at the api layer if needed.

/** Session 附件引用当前对应的本地文件状态。 */
export type SessionAttachmentFileStatus =
  | 'available'
  | 'modified'
  | 'missing'
  | 'inaccessible';

/** GET /api/sessions/:id/attachments 返回的稳定跨进程附件结构。 */
export interface SessionAttachmentWire {
  id:         string;
  turnId:     string;
  sessionId:  string;
  name:       string;
  mimeType:   string;
  size:       number;
  mtime:      number;
  fileHandle: string | null;
  createdAt:  number;
  fileStatus: SessionAttachmentFileStatus;
}

export interface SessionAttachmentsResult {
  attachments: SessionAttachmentWire[];
}

// ── Session dashboard wire types ──────────────────────────────────────────────

export interface ArtifactSummaryWire {
  id:              string;
  type:            string;
  title:           string;
  contentLocation: 'inline' | 'file';
  byteSize:        number;
  createdAt:       number;
  appliedAt:       number | null;
  rejectedAt:      number | null;
}

export interface AudioEntryWire {
  turnId:       string;
  mimeType:     string;
  byteSize:     number;
  durationMs:   number | null;
  segmentCount: number;
  createdAt:    number;
}

export interface SessionNoteEntryWire {
  timestamp: string;
  delta:     string;
}

export interface SessionNoteWire {
  sessionId:          string;
  entries:            SessionNoteEntryWire[];
  tokensAtLastUpdate: number;
  updatedAt:          number;
}

export interface SessionDashboardWire {
  sessionId:            string;
  turnCount:            number;
  messageCount:         number;
  totalInputTokens:     number;
  totalOutputTokens:    number;
  modeCounts:           { chat: number; narrative: number; agent: number };
  branchCount:          number;
  artifactCount:        number;
  artifactTotalBytes:   number;
  artifacts:            ArtifactSummaryWire[];
  audioTurnCount:       number;
  audioTotalBytes:      number;
  audioTotalDurationMs: number;
  audioEntries:         AudioEntryWire[];
  attachmentCount:      number;
  attachmentTotalBytes: number;
  notes:                SessionNoteWire | null;
}
