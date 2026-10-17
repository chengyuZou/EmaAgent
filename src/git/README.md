# @ema-agent/git

[中文](./README-zh.md)

Read repository information and patches through the system Git executable. Ema uses the query functions for the desktop session header and review panel, and the baseline functions to track changes in Memory directories.

## Repository queries

```ts
import { gitSummary, gitWorkspaceDiff } from '@ema-agent/git';

const cwd = '/path/to/repository';
const summary = await gitSummary(cwd);
if ('status' in summary) {
  console.error(summary);
} else {
  console.log(summary.branch, summary.untrackedCount);
}

const diff = await gitWorkspaceDiff(cwd, 'uncommitted');
if ('status' in diff) {
  console.error(diff);
} else {
  console.log(diff.patch, diff.omittedFiles);
}
```

The query functions search upward from `cwd` for an accessible `.git` directory or pointer file, then run Git from that directory. Passing a repository subdirectory therefore queries the whole repository. Git validates the repository when the commands run.

| Function | Return type | Successful result |
| --- | --- | --- |
| `gitSummary(cwd)` | `GitSummaryResult` | Repository root, branch, tracked staged and unstaged statistics, untracked file count, upstream, and origin URL. |
| `gitWorkspaceDiff(cwd, scope)` | `GitWorkspaceDiffResult` | Repository root, a native Git `patch`, and the number of untracked files whose patches could not be read. |
| `gitCompareDiff(cwd, target)` | `GitCompareResult` | Repository root and a native Git `patch` for a commit or branch comparison. |
| `gitRefs(cwd)` | `GitRefsResult` | Current branch, local branch names, and up to 50 recent commits from HEAD with full IDs and subjects. |

`GitCommits` is the shared readonly list type used by the commit query and `GitRefsResult.commits`. Each entry has `sha` and `subject`.

`gitSummary` reports `headShortSha` when it cannot obtain a branch name. A detached HEAD has `branch: null`. Missing or failed upstream and origin lookups return `null`. Untracked directories are expanded into individual files for counting.

Workspace diff scopes have different starting points:

| Scope | Tracked files | Untracked files |
| --- | --- | --- |
| `uncommitted` | HEAD to current disk contents. | Included. |
| `staged` | HEAD to the index. | Excluded. |
| `unstaged` | Index to current disk contents. | Included. |

`uncommitted` shows the final change from HEAD. A file staged with new content and then restored on disk can have no final difference, even though the staged and unstaged views both contain changes. Before the first commit, the comparison starts from an empty tree whose ID Git calculates for the repository's object format.

For comparisons, `{ kind: 'commit', sha }` reads the patch produced by `git show` for that commit. `{ kind: 'branch', branch }` finds the merge base of HEAD and the selected branch, then compares that base with the current tracked disk contents. The branch comparison includes staged and unstaged changes to tracked files.

### Results and limits

Successful queries return their data fields directly. Failures carry a `status` field. Check `'status' in result` before reading the data:

- `not-a-repo`: No accessible `.git` was found in `cwd` or its parents.
- `git-unavailable`: Git could not be started because the executable was not found.
- `diff-too-large`: A workspace or comparison patch exceeded its size limit, or a workspace query found too many untracked files.
- `error`: Another Git command failure, including timeout. `message` describes the failed command.

A clean scope returns an empty patch with the repository root and `omittedFiles`. Workspace queries count failed untracked-file patch commands in `omittedFiles` and return the remaining patches. Patch headers for empty files, binary files, renames, and mode changes are retained. Review queries return `diff-too-large` instead of truncating a patch.

[`errors.ts`](./errors.ts) defines `GitUnavailableError`, `GitTimeoutError`, `GitCommandError`, `GitOutputTooLargeError`, and `GitDiffTooLargeError`. Queries convert the expected failures into results. Baseline functions throw the relevant errors to their callers. Unexpected errors continue to throw. A process output limit and a review size limit are separate failures; the review view treats both as `diff-too-large`, while baseline reads handle output limits by marking the body incomplete.

Command defaults are in [`gitProcess.ts`](./gitProcess.ts), review limits in [`diff.ts`](./diff.ts), and baseline limits in [`baseline.ts`](./baseline.ts):

| Limit | Current value |
| --- | --- |
| Default timeout per Git command | 100 seconds. Baseline writes and baseline storage cleanup use 30 seconds. |
| Default buffer per output stream | 16 MiB. Review patch commands use 8 MiB. |
| Review patch size | 2,000,000 JavaScript string code units. |
| Untracked files per workspace review query | 500. Their patches are read in batches of 8 Git commands. |
| Patch context | 3 lines. |

## Memory baselines

A baseline is the current HEAD of a Git repository owned by a Memory directory. It records the directory contents last accepted by Memory consolidation.

| Function | Behavior |
| --- | --- |
| `hasUsableBaseline(root)` | Checks whether Git can resolve HEAD from `root`. |
| `ensureBaseline(root)` | Keeps a resolvable HEAD. Otherwise attempts to initialize and commit the current directory contents. |
| `resetBaseline(root)` | Stages current additions, edits, and deletions, then creates the first commit or amends the last commit. |
| `diffSinceBaseline(root, options?)` | Returns file changes and a bounded unified diff from current HEAD to disk, including untracked files. |
| `compactBaselineStorage(root)` | Expires reflog entries and prunes old Git objects left by repeated amendments. |

Use an existing directory dedicated to this baseline, with its own repository or intended to become one. Git searches parent directories, so a successful HEAD check alone does not prove that `root` has its own `.git`. Callers must provide the correct root and run operations on the same directory in sequence. Resetting changes the index and HEAD while keeping current file contents. An initially single-commit baseline stays that way through amendments; amending an existing multi-commit repository keeps its earlier history.

`diffSinceBaseline` queries its file list separately from the patch body. Renames appear as deletion and addition. More than 200 changes sets `unifiedSkipped: true` and returns an empty body with the file list. The default body limit is 4 MiB of UTF-8 text, overridden by `options.maxDiffBytes`. `truncated` means the body is incomplete because of that limit or a Git output-buffer limit. Truncation preserves complete UTF-8 characters. `omittedFiles` counts failed untracked-file patch reads.

[`gitWorkspace.ts`](../memory/common/gitWorkspace.ts) manages these calls for Memory. It removes the generated `memory_workspace_diff.md` before comparison, writes the new file list and patch there for consolidation, and removes it again before accepting changes into the next baseline. [`runConsolidationJobs.ts`](../memory/jobs/runConsolidationJobs.ts) accepts the new baseline after applying consolidation edits. [Memory maintenance](../memory/capacity/maintenance.ts) calls storage cleanup for its internal repositories.

## Integration and checks

The desktop queries [session Git routes](../../apps/server/src/routes/sessions/git.ts) through [`sessionGitApi`](../../apps/desktop/src/api/git.ts). The server obtains `cwd` from the session and returns the query result as JSON. [`SessionHeader`](../../apps/desktop/src/chat/session/SessionHeader.tsx) reads the summary. [`gitDiffContext`](../../apps/desktop/src/chat/session/gitDiffContext.tsx) parses workspace patches with `@pierre/diffs` for the header's change counts and the review panel. Refs and comparison queries are also exposed by the routes.

Git must be available on the server process's `PATH`. [`gitProcess.ts`](./gitProcess.ts) starts it without a shell, disables configured hooks and fsmonitor, skips optional locks, and disables terminal credential prompts. Required write locks still apply. Review diff queries also disable external diff, text conversion, and configured clean/process filters.

From the repository root:

```sh
pnpm --filter @ema-agent/git test
pnpm --filter @ema-agent/git typecheck
```

Tests create temporary repositories for summary queries, diff scopes, initial SHA-1 and SHA-256 repositories, and baseline resets and limits. Process tests check command failures and output limits. Integration cases skip when Git cannot start. The package's source entry is [`index.ts`](./index.ts); query logic is in [`summary.ts`](./summary.ts), [`refs.ts`](./refs.ts), and [`diff.ts`](./diff.ts), with baseline behavior in [`baseline.ts`](./baseline.ts).

