/**
 * Memory bench — entry point
 *
 * Usage:
 *   npx tsx bench/index.ts                    # default: recall + latency
 *   npx tsx bench/index.ts recall             # recall quality only
 *   npx tsx bench/index.ts latency            # latency only
 *   npx tsx bench/index.ts all                # all suites
 *   npx tsx bench/index.ts recall --k=10      # pass args through
 *
 * From package root (after adding "bench" script to package.json):
 *   pnpm --filter @ema-agent/memory bench
 */

import { execSync }    from 'node:child_process';
import path            from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const SUITES: Record<string, string> = {
  recall:    path.resolve(__dir, 'runners/recall-quality.bench.ts'),
  latency:   path.resolve(__dir, 'runners/latency.bench.ts'),
  embedding:  path.resolve(__dir, 'runners/embedding-recall.bench.ts'),
  extracted:  path.resolve(__dir, 'runners/extracted-recall.bench.ts'),
  planner:    path.resolve(__dir, 'runners/planner-recall.bench.ts'),
  // coming soon:
  // tokens:  path.resolve(__dir, 'runners/tokens.bench.ts'),
  // routing: path.resolve(__dir, 'runners/routing.bench.ts'),
  // compact: path.resolve(__dir, 'runners/compaction.bench.ts'),
};

// Default excludes embedding (requires API key + ~5 min on first run)
const DEFAULT_SUITES = ['recall', 'latency'];

// Separate suite names from passthrough flags (--k, --n, etc.)
const positional = process.argv.slice(2).filter(a => !a.startsWith('-'));
const flags      = process.argv.slice(2).filter(a => a.startsWith('-')).join(' ');
const suiteArg   = positional[0] ?? 'default';

const selected: string[] =
  suiteArg === 'all'     ? Object.values(SUITES)
  : suiteArg === 'default' ? DEFAULT_SUITES.map(k => SUITES[k]!)
  : SUITES[suiteArg]       ? [SUITES[suiteArg]!]
  : [];

if (selected.length === 0) {
  console.error(`Unknown suite: "${suiteArg}"`);
  console.error(`Available: ${Object.keys(SUITES).join(', ')}, all`);
  process.exit(1);
}

for (const suite of selected) {
  const name = path.basename(suite, '.ts');
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${name}  ${flags}`);
  console.log('═'.repeat(60));
  execSync(
    `npx tsx ${suite} ${flags}`,
    { stdio: 'inherit', cwd: path.resolve(__dir, '..') },
  );
}

console.log('\n[bench] Done.');
