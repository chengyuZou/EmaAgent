import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';

const execFileAsync = promisify(execFile);

// ── Input schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  pattern: z.string().min(1).describe(
    'Glob pattern, e.g. "**/*.ts" or "src/**/*.{tsx,jsx}". ' +
      'Relative patterns are resolved against `path`.',
  ),
  path: z
    .string()
    .optional()
    .describe('Directory to search in. Defaults to the workspace root.'),
});

type GlobInput = z.infer<typeof inputSchema>;

// ── Output type ───────────────────────────────────────────────────────────────

export interface GlobResult {
  /** Matching file paths, sorted by mtime descending (most recently modified first). */
  files: string[];
  truncated: boolean;
}

const MAX_RESULTS = 1000;

// ── Tool definition ───────────────────────────────────────────────────────────

export const globTool = buildTool<GlobInput, GlobResult>({
  name: 'glob',
  description: `Fast file pattern matching using ripgrep's --files mode.

- Supports glob syntax: \`**/*.ts\`, \`src/**/*.{tsx,jsx}\`, etc.
- Results are sorted by modification time (newest first) — up to ${MAX_RESULTS} files.
- Use \`path\` to restrict the search to a subdirectory.`,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
  },

  async execute(input: GlobInput, ctx: ToolExecutionContext): Promise<GlobResult> {
    const searchDir = input.path
      ? path.resolve(input.path)
      : ctx.workspaceRoot;

    // Use ripgrep --files for fast glob matching.
    // rg is expected on PATH (ships with many dev setups; we'll add to our binary dist).
    // Fall back to Node glob if rg is absent.
    let rawPaths: string[];
    try {
      rawPaths = await rgGlob(input.pattern, searchDir, ctx.signal);
    } catch {
      rawPaths = await nodeGlob(input.pattern, searchDir, ctx.signal);
    }

    // Sort by mtime descending
    const withMtime = rawPaths.map((p) => {
      try {
        const { mtimeMs } = fs.statSync(p);
        return { p, mtime: mtimeMs };
      } catch {
        return { p, mtime: 0 };
      }
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const truncated = withMtime.length > MAX_RESULTS;
    const files = withMtime.slice(0, MAX_RESULTS).map((x) => x.p);

    return { files, truncated };
  },
});

// ── Backends ──────────────────────────────────────────────────────────────────

async function rgGlob(
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'rg',
    ['--files', '--glob', pattern, '--null', '.'],
    { cwd: searchDir, signal, maxBuffer: 50 * 1024 * 1024 },
  );
  return stdout.split('\0').filter(Boolean).map((p) => path.resolve(searchDir, p));
}

async function nodeGlob(
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  // Dynamic import — glob is a common dep, we add it in package.json
  const { glob } = await import('glob');
  const results = await glob(pattern, {
    cwd: searchDir,
    absolute: true,
    nodir: true,
    signal,
  });
  return results;
}
