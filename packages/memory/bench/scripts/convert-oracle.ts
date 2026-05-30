/**
 * convert-oracle.ts — LongMemEval oracle → EmaAgent memory bench fixture
 *
 * Usage:
 *   npx tsx packages/memory/bench/scripts/convert-oracle.ts
 *
 * Input:  D:/Github/LongMemEval/data/longmemeval_oracle.json
 * Output: packages/memory/bench/fixtures/chat-oracle.json
 *
 * Field mapping:
 *   question_id         → id
 *   question_type       → questionType  (normalised)
 *   question            → query
 *   question_date       → questionDate
 *   answer              → groundTruth
 *   haystack_sessions   → messages[]   (flat, sessionIdx / msgIdx / isEvidence)
 *   haystack_dates      → sessionDates
 *   has_answer:true ids → relevantMessageIds  (format: "<si>_<mi>")
 *   derived             → evidenceCount, sessionCount, totalMessages
 *
 * Filters applied:
 *   - Skip cases where total haystack messages < MIN_HISTORY_MSGS
 *   - Keep at most MAX_CASES (statistically sufficient at 95 % CI ±4 %)
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const ORACLE_PATH  = 'D:/Github/LongMemEval/data/longmemeval_oracle.json';
const OUTPUT_PATH  = path.resolve(__dir, '../fixtures/chat-oracle.json');
const MAX_CASES         = 500;
const MIN_HISTORY_MSGS  = 10;

// ── Wire types (oracle JSON) ──────────────────────────────────────────────────

interface OracleMessage {
  role:       'user' | 'assistant';
  content:    string;
  has_answer: boolean;
}

interface OracleCase {
  question_id:        string;
  question_type:      string;
  question:           string;
  answer:             string;
  question_date?:     string;
  haystack_dates?:    string[];
  haystack_session_ids?: string[];
  haystack_sessions:  OracleMessage[][];
}

// ── Fixture types (output) ────────────────────────────────────────────────────

export type QuestionType =
  | 'single_hop'
  | 'temporal'
  | 'multi_session'
  | 'knowledge_update'
  | 'adversarial';

export interface BenchMessage {
  sessionIdx: number;
  msgIdx:     number;
  role:       'user' | 'assistant';
  content:    string;
  isEvidence: boolean;
}

export interface BenchCase {
  id:                  string;
  questionType:        QuestionType;
  query:               string;
  /** question_date from oracle (e.g. "2023/04/10 (Mon) 23:07") */
  questionDate:        string | null;
  groundTruth:         string;
  mode:                'chat';
  messages:            BenchMessage[];
  /** "<sessionIdx>_<msgIdx>" for every has_answer:true message */
  relevantMessageIds:  string[];
  /** Dates for each haystack session (order matches messages[].sessionIdx) */
  sessionDates:        string[];
  evidenceCount:       number;   // = relevantMessageIds.length
  sessionCount:        number;   // = number of distinct sessionIdx values
  totalMessages:       number;   // = messages.length
}

export interface BenchFixture {
  meta: {
    source:       string;
    generatedAt:  string;
    totalCases:   number;
    filterMinMsgs: number;
  };
  cases: BenchCase[];
}

// ── Question type normalisation ───────────────────────────────────────────────

const TYPE_MAP: Record<string, QuestionType> = {
  'temporal-reasoning':         'temporal',
  'multi-session':              'multi_session',
  'knowledge-update':           'knowledge_update',
  'single-session-preference':  'single_hop',
  'single-session-assistant':   'single_hop',
  'single-session-user':        'single_hop',
  'adversarial':                'adversarial',
};

// ── Main ──────────────────────────────────────────────────────────────────────

function convert(): void {
  console.log(`[convert] Reading ${ORACLE_PATH} …`);
  if (!fs.existsSync(ORACLE_PATH)) {
    console.error(`[convert] ERROR: file not found: ${ORACLE_PATH}`);
    process.exit(1);
  }

  const raw: OracleCase[] = JSON.parse(fs.readFileSync(ORACLE_PATH, 'utf-8'));
  console.log(`[convert] ${raw.length} oracle records`);

  const cases: BenchCase[] = [];
  let skippedShort   = 0;
  let skippedUnknown = 0;

  for (const oc of raw) {
    // ── Flatten sessions ────────────────────────────────────────────────────
    const messages: BenchMessage[]  = [];
    const evidenceIds: string[]      = [];

    for (let si = 0; si < oc.haystack_sessions.length; si++) {
      const session = oc.haystack_sessions[si]!;
      for (let mi = 0; mi < session.length; mi++) {
        const msg = session[mi]!;
        const id  = `${si}_${mi}`;
        messages.push({
          sessionIdx: si,
          msgIdx:     mi,
          role:       msg.role,
          content:    msg.content,
          isEvidence: msg.has_answer === true,
        });
        if (msg.has_answer === true) evidenceIds.push(id);
      }
    }

    // ── Filters ─────────────────────────────────────────────────────────────
    if (messages.length < MIN_HISTORY_MSGS) { skippedShort++;   continue; }

    const questionType = TYPE_MAP[oc.question_type];
    if (!questionType) {
      console.warn(`[convert] unknown type "${oc.question_type}" (${oc.question_id}) — skipped`);
      skippedUnknown++;
      continue;
    }

    cases.push({
      id:                 oc.question_id,
      questionType,
      query:              oc.question,
      questionDate:       oc.question_date ?? null,
      groundTruth:        oc.answer,
      mode:               'chat',
      messages,
      relevantMessageIds: evidenceIds,
      sessionDates:       oc.haystack_dates ?? [],
      evidenceCount:      evidenceIds.length,
      sessionCount:       oc.haystack_sessions.length,
      totalMessages:      messages.length,
    });

    if (cases.length >= MAX_CASES) break;
  }

  // ── Write output ─────────────────────────────────────────────────────────
  const fixture: BenchFixture = {
    meta: {
      source:        'LongMemEval oracle',
      generatedAt:   new Date().toISOString(),
      totalCases:    cases.length,
      filterMinMsgs: MIN_HISTORY_MSGS,
    },
    cases,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(fixture, null, 2), 'utf-8');

  // ── Stats ─────────────────────────────────────────────────────────────────
  const byType: Record<string, number> = {};
  let totalEvidence = 0;
  let totalMessages = 0;
  for (const c of cases) {
    byType[c.questionType] = (byType[c.questionType] ?? 0) + 1;
    totalEvidence += c.evidenceCount;
    totalMessages += c.totalMessages;
  }

  const sizeMb = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`\n[convert] ✓ ${cases.length} cases → ${OUTPUT_PATH} (${sizeMb} MB)`);
  console.log(`[convert] skipped: ${skippedShort} (too short), ${skippedUnknown} (unknown type)`);
  console.log(`[convert] avg messages/case : ${(totalMessages  / cases.length).toFixed(1)}`);
  console.log(`[convert] avg evidence/case : ${(totalEvidence  / cases.length).toFixed(2)}`);
  console.log('[convert] question type distribution:');
  for (const [t, n] of Object.entries(byType)) {
    const pct = ((n / cases.length) * 100).toFixed(1);
    console.log(`  ${t.padEnd(20)} ${String(n).padStart(4)}  (${pct}%)`);
  }
}

convert();
