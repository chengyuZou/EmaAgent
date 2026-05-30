/**
 * convert-ema-oracle.ts — Ema oracle JSON → bench fixture
 *
 * 把 gen-ema-oracle.ts 生成的 ema-oracle.json 转换成
 * recall-quality / planner-recall 等 bench runner 能直接读的 fixture 格式。
 *
 * Usage:
 *   npx tsx bench/scripts/convert-ema-oracle.ts
 *
 * Input:  bench/fixtures/ema-oracle.json
 * Output: bench/fixtures/ema-chat-oracle.json
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const INPUT_PATH  = path.resolve(__dir, '../fixtures/ema-oracle.json');
const OUTPUT_PATH = path.resolve(__dir, '../fixtures/ema-chat-oracle.json');

// ── Input types (from gen-ema-oracle.ts) ──────────────────────────────────────

interface EmaOracleMsg {
  role:       'user' | 'assistant';
  content:    string;
  has_answer: boolean;
}

interface EmaOracleSession {
  session_id: string;
  messages:   EmaOracleMsg[];
}

interface EmaOracleCase {
  question_id:        string;
  question_type:      string;
  question:           string;
  answer:             string;
  haystack_sessions:  EmaOracleSession[];
}

interface EmaOracleFile {
  meta:  { generated_at: string; total_cases: number; model: string };
  cases: EmaOracleCase[];
}

// ── Output types (bench fixture — shared with chat-oracle.json) ───────────────

interface BenchMessage {
  sessionIdx:  number;
  msgIdx:      number;
  role:        'user' | 'assistant';
  content:     string;
  isEvidence:  boolean;
}

interface BenchCase {
  id:                  string;
  questionType:        string;
  query:               string;
  questionDate:        null;
  groundTruth:         string;
  mode:                'chat';
  messages:            BenchMessage[];
  relevantMessageIds:  string[];      // "si_mi" for evidence messages
  evidenceCount:       number;
  sessionCount:        number;
  totalMessages:       number;
}

interface BenchFixture {
  meta: {
    source:        string;
    generatedAt:   string;
    totalCases:    number;
    language:      'zh';
    character:     '樱羽艾玛';
  };
  cases: BenchCase[];
}

// ── Conversion ────────────────────────────────────────────────────────────────

function convertCase(raw: EmaOracleCase): BenchCase | null {
  const messages: BenchMessage[]     = [];
  const relevantIds: string[]        = [];
  let   evidenceCount  = 0;

  for (let si = 0; si < raw.haystack_sessions.length; si++) {
    const session = raw.haystack_sessions[si]!;
    const sessionMsgs = session.messages ?? [];

    for (let mi = 0; mi < sessionMsgs.length; mi++) {
      const msg = sessionMsgs[mi]!;
      if (!msg.content?.trim()) continue;

      const isEvidence = msg.role === 'user' && msg.has_answer === true;
      const id         = `${si}_${mi}`;

      messages.push({
        sessionIdx: si,
        msgIdx:     mi,
        role:       msg.role,
        content:    msg.content,
        isEvidence,
      });

      if (isEvidence) {
        relevantIds.push(id);
        evidenceCount++;
      }
    }
  }

  // Must have at least 1 evidence message and at least 5 total messages
  if (evidenceCount === 0 || messages.length < 5) return null;

  return {
    id:                 raw.question_id,
    questionType:       raw.question_type,
    query:              raw.question,
    questionDate:       null,
    groundTruth:        raw.answer,
    mode:               'chat',
    messages,
    relevantMessageIds: relevantIds,
    evidenceCount,
    sessionCount:       raw.haystack_sessions.length,
    totalMessages:      messages.length,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`[convert-ema] Input not found: ${INPUT_PATH}`);
    console.error('  Run: npx tsx bench/scripts/gen-ema-oracle.ts first');
    process.exit(1);
  }

  const raw: EmaOracleFile = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  console.log(`[convert-ema] Input: ${raw.cases.length} raw cases`);

  const cases: BenchCase[] = [];
  let skipped = 0;

  for (const c of raw.cases) {
    const converted = convertCase(c);
    if (converted) {
      cases.push(converted);
    } else {
      skipped++;
      console.warn(`  Skip ${c.question_id}: no valid evidence or too few messages`);
    }
  }

  const byType: Record<string, number> = {};
  for (const c of cases) byType[c.questionType] = (byType[c.questionType] ?? 0) + 1;

  const fixture: BenchFixture = {
    meta: {
      source:      `gen-ema-oracle (${raw.meta.model})`,
      generatedAt: new Date().toISOString(),
      totalCases:  cases.length,
      language:    'zh',
      character:   '樱羽艾玛',
    },
    cases,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(fixture, null, 2), 'utf-8');

  console.log(`[convert-ema] Output: ${cases.length} cases (skipped ${skipped})`);
  console.log(`[convert-ema] By type: ${JSON.stringify(byType)}`);
  console.log(`[convert-ema] Saved → ${OUTPUT_PATH}`);

  // Stats
  const avgMsgs   = Math.round(cases.reduce((a, c) => a + c.totalMessages, 0) / cases.length);
  const avgEvid   = (cases.reduce((a, c) => a + c.evidenceCount, 0) / cases.length).toFixed(1);
  console.log(`[convert-ema] Avg messages/case: ${avgMsgs}  avg evidence/case: ${avgEvid}`);
}

main();
