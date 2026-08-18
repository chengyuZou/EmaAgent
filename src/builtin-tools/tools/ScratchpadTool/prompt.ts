// Scratchpad 工具族的模型说明书:五个 Tool 的 description 在此单点维护,限额与引擎常量同源。
import {
  MAX_SCRATCHPAD_KEYS,
  MAX_SCRATCHPAD_TOTAL_BYTES,
  MAX_SCRATCHPAD_VALUE_BYTES,
} from './ScratchpadStore.js';

const VALUE_LIMIT_KB = MAX_SCRATCHPAD_VALUE_BYTES / 1024;
const TOTAL_LIMIT_MB = MAX_SCRATCHPAD_TOTAL_BYTES / 1024 / 1024;

export const SCRATCHPAD_WRITE_DESCRIPTION = `Write a value into the turn-scoped scratchpad — a temporary key-value store shared by the current agent and its sub-agents.

Use the scratchpad to:
- Park intermediate results (research notes, extracted data, drafts) without bloating the conversation context
- Checkpoint long-task progress so another agent can pick up where a previous one left off
- Aggregate parallel sub-agent outputs before a final synthesis step

Do NOT use it for:
- Final deliverables — write those to real files with the file tools
- Small values that fit comfortably in the conversation directly

Limits: ${VALUE_LIMIT_KB} KB per value, ${TOTAL_LIMIT_MB} MB total, ${MAX_SCRATCHPAD_KEYS} keys. A write that would exceed a limit fails — delete unused keys or call ScratchpadClear first.

The scratchpad only exists in work Turns and is deleted automatically when the Turn ends. Never store information that must survive the Turn.`;

export const SCRATCHPAD_READ_DESCRIPTION = `Read a value from the turn-scoped scratchpad by key.

Returns { "value": null } when the key has not been written — this is not an error. Use ScratchpadList first to discover which keys exist and which agent wrote them.`;

export const SCRATCHPAD_LIST_DESCRIPTION = `List all keys currently stored in the turn-scoped scratchpad, with sizes, token estimates, and which agent wrote each entry.

Use this before reading to discover what sub-agents have written, and to check quota usage before large writes.`;

export const SCRATCHPAD_DELETE_DESCRIPTION = `Delete a single key from the turn-scoped scratchpad. Returns { "deleted": false } when the key does not exist.

Use this to free quota after a sub-agent's output has been consumed.`;

export const SCRATCHPAD_CLEAR_DESCRIPTION = `Delete every key in the turn-scoped scratchpad and reset quota usage to zero.

Use this when intermediate working state is no longer needed before writing the final result, or when approaching the ${TOTAL_LIMIT_MB} MB total limit.`;
