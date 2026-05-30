/**
 * deepseek.ts — DeepSeek extraction client with disk cache.
 *
 * Purpose: extract structured memory items from raw oracle conversations.
 * Caches results to bench/cache/extractions.json — zero LLM calls on rerun.
 *
 * Config (env vars override hard-coded defaults):
 *   DEEPSEEK_API_KEY    DeepSeek secret key
 *   DEEPSEEK_BASE_URL   defaults to https://api.deepseek.com/v1
 *   DEEPSEEK_MODEL      defaults to deepseek-chat
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com/v1';
const API_KEY  = process.env['DEEPSEEK_API_KEY']  ?? '';
const MODEL    = process.env['DEEPSEEK_MODEL']     ?? 'deepseek-chat';

const CACHE_PATH = path.resolve(__dir, '../cache/extractions.json');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractedItem {
  title: string;
  body:  string;
}

type ExtractionCache = Record<string, ExtractedItem[]>;

// ── Disk cache ────────────────────────────────────────────────────────────────

export class ExtractionCache {
  private store: ExtractionCache = {};
  private dirty = false;

  constructor(private readonly filePath = CACHE_PATH) {
    if (fs.existsSync(filePath)) {
      try {
        this.store = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ExtractionCache;
      } catch {
        this.store = {};
      }
    }
  }

  size(): number { return Object.keys(this.store).length; }
  has(caseId: string): boolean { return caseId in this.store; }
  get(caseId: string): ExtractedItem[] | undefined { return this.store[caseId]; }

  set(caseId: string, items: ExtractedItem[]): void {
    this.store[caseId] = items;
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), 'utf-8');
    this.dirty = false;
  }
}

// ── Extraction prompt ─────────────────────────────────────────────────────────
//
// We pass ONLY user messages (assistant messages are generic "I'm an LLM" boilerplate
// in the oracle data and would dilute extraction quality).
// Max 20 user messages to stay within a cheap token budget.

const SYSTEM_PROMPT = `\
You are a memory extraction system for a personal AI assistant.
Read the user's messages from a conversation and extract key facts,
events, preferences, and personal details they mentioned.

Rules:
- Extract ONLY information the USER stated — not the AI's responses
- Each item must be self-contained and understandable without conversation context
- Write each fact as a short declarative sentence about the user
- Be specific: include numbers, dates, names when present
- TIME EXPRESSIONS: whenever the user mentions a relative time ("tomorrow", "next week",
  "yesterday", "this Friday", "下周", "明天", "昨天", "这周五" etc.), you MUST preserve
  both the activity AND the time expression together in the body.
  Bad:  "User is going on a business trip."
  Good: "User mentioned going on a business trip next week (下周出差)."
  This is critical — temporal queries depend on this context being present.
- Extract 4–10 items; skip filler messages ("ok", "thanks")
- Return ONLY a valid JSON array: [{"title":"short label","body":"fact sentence"}, ...]
- No markdown, no explanation, just raw JSON`;

function buildUserPrompt(userMessages: string[]): string {
  const lines = userMessages
    .slice(0, 20)
    .map((m, i) => `[${i + 1}] ${m.trim()}`)
    .join('\n\n');
  return `User messages:\n\n${lines}`;
}

// ── API call ──────────────────────────────────────────────────────────────────

async function callDeepSeek(userPrompt: string): Promise<ExtractedItem[]> {
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:       MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
      temperature:      0.1,    // low temp for consistent structured output
      max_tokens:       1024,
      response_format:  { type: 'json_object' },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`DeepSeek ${resp.status}: ${body.slice(0, 200)}`);
  }

  const json = await resp.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const raw = json.choices[0]?.message.content ?? '[]';

  // Model sometimes returns { "items": [...] } instead of bare array
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }

  if (Array.isArray(parsed)) return parsed as ExtractedItem[];

  const obj = parsed as Record<string, unknown>;
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) return val as ExtractedItem[];
  }
  return [];
}

// ── Public: extract many cases with caching ───────────────────────────────────

export interface CaseInput {
  id:           string;
  userMessages: string[];   // plain text of user messages
}

export async function extractMany(
  cases:       CaseInput[],
  cache:       ExtractionCache,
  onProgress?: (done: number, total: number, caseId: string) => void,
): Promise<void> {
  const todo = cases.filter(c => !cache.has(c.id));
  if (todo.length === 0) return;

  for (let i = 0; i < todo.length; i++) {
    const c = todo[i]!;
    try {
      const items = await callDeepSeek(buildUserPrompt(c.userMessages));
      cache.set(c.id, items.filter(it => it.title && it.body));
    } catch (err) {
      console.warn(`\n[extract] WARN case ${c.id}: ${(err as Error).message}`);
      cache.set(c.id, []);   // cache empty to avoid retry storm
    }
    onProgress?.(i + 1, todo.length, c.id);

    // Persist every 50 cases so a crash doesn't waste all prior API calls
    if ((i + 1) % 50 === 0) cache.save();

    // Polite delay: avoid triggering rate limits across 467 sequential calls
    if (i + 1 < todo.length) await new Promise<void>(r => setTimeout(r, 200));
  }

  cache.save();
}
