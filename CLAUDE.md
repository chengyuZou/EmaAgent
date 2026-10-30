# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

EmaAgent is a local-first, single-user desktop app: an anime character companion (persona, Live2D, voice) plus a coding/work Agent (files, shell, web, Tasks, Goals, subagents). Tauri + React frontend, local Node.js Server, SQLite storage under `~/.ema-agent` (override with `EMA_PROFILE_DIR`).

## Working agreements

The current user request and confirmed decisions define the work. Answer discussion and review requests before editing. Old TODOs and investigation notes do not authorize changes. If a design reason is unknown or a name changes the business meaning, explain the uncertainty and ask before deciding.

Read the implementation, producers, boundaries, consumers, and relevant existing tests before changing behavior. Use concrete names and explanations: who creates or reads a value, what is being awaited, what ends the wait, and what happens on cancellation. Do not replace these explanations with vague terms such as host, runtime, or preflight.

Prefer the simplest implementation that meets the supported behavior. Every field, interface, and check needs a real producer and consumer. Do not add wrappers, compatibility paths, or hypothetical extension points without a current use. Reuse the project's UI components and shared business types.

Inspect Git status, diffs, or history only when explicitly requested. Do not stage, commit, reset, push, or remove unrelated work without authorization. Tests use temporary directories or in-memory databases; reading or changing an existing user database needs a confirmed target and scope.

Match verification to the change and reuse relevant tests. Documentation edits do not require new test files or application builds. UI and native behavior require actual interaction checks, and native changes require rebuilding and restarting the host. Report exactly which checks ran.

## Commands

pnpm 9 workspace (`src/*` and `apps/*`) driven by Turbo. Node >= 22 and Rust >= 1.90; release builds need the exact Node in `apps/desktop/release-config.json`.

```sh
pnpm install --frozen-lockfile
pnpm build                 # all packages, dependency order (required before first dev run)
pnpm dev:start             # full app: Tauri host starts Server + Vite (port 1420)
pnpm dev                   # Vite only - no native host, no Server
pnpm typecheck             # whole workspace
pnpm test                  # whole workspace via Turbo (each package builds first)
pnpm dev:reset             # DESTRUCTIVE: deletes everything in the active profile dir
pnpm release [--server-only]
```

Per package (`@ema-agent/<dir name>`, e.g. `@ema-agent/turn`, `@ema-agent/server`, `@ema-agent/desktop`):

```sh
pnpm --filter @ema-agent/turn test
pnpm --filter @ema-agent/turn typecheck
pnpm --filter @ema-agent/turn exec vitest run tests/turnStore.test.ts -t "test name"   # single test
pnpm --filter "@ema-agent/turn..." build    # the package and everything it depends on
```

Desktop extras: `pnpm --filter @ema-agent/desktop test:scripts` (release version checks), `pnpm --filter @ema-agent/desktop test:live2d-release` (headless browser render of the real stage; needs Cubism Core), and `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` for the Rust host.

The root `pnpm test:scripts` forwards to Desktop's release-script tests. `pnpm test:watch` uses Turbo to rerun affected build and test tasks after changes, while Storage retains its own focused Vitest watch command. `pnpm typecheck` is the static check.

## Build model - the main gotcha

Every `src/*` package exports compiled `./dist/index.js`, and dependents (Server, Desktop, other packages) resolve the `dist` output, not source. After editing a package, rebuild it (and anything between it and the consumer) before testing or running a dependent - otherwise you are exercising stale code. `pnpm --filter <pkg> test` runs vitest directly and does not rebuild dependencies; `pnpm test` via Turbo does.

Each package build clears its own `dist` before compiling, and every package has a `clean` command. `pnpm clean` removes these outputs but preserves native Rust targets and user profiles. Shared TypeScript options live in `tsconfig.base.json`; Turbo tracks that file as a global cache input. Keep `rootDir`, `outDir`, and browser/Node module differences in the package configurations.

Package source sits directly in `src/<pkg>/` (no inner `src/`); tests live in `src/<pkg>/tests/*.test.ts`. Desktop tests live in `apps/desktop/tests/` and `apps/desktop/src/**/tests/`; DOM tests opt into jsdom themselves. `.gitignore` ignores all `*.js` / `*.d.ts`, so hand-written JS must be `.mjs` (or added as an explicit exception).

`@ema-agent/storage` build also copies `migrations/` into `dist/migrations`; shipping only compiled JS breaks fresh installs.

## Architecture

```
apps/desktop  (React: stage window index.html + main window main.html; Tauri host in src-tauri/)
     |  spawns Server child process, reads one JSON line {"method":"server.ready","params":{"port"}} from stdout,
     |  hands port + shared secret to both WebViews
apps/server   (Hono on 127.0.0.1, random port, X-Ema-Secret auth)
     |  composes the business packages
src/*         (business packages, one domain each)
```

**Server** (`apps/server/src`): `main.ts` -> `platform/lifecycle.ts` (opens + migrates profile, data, narrative DBs in that order; marks interrupted work as ended) -> `composition/index.ts` (constructs and wires all business objects; owns shutdown cancellation order) -> `routes/index.ts` (`createRoutes`, exports `AppType`). `application/` holds operations spanning several packages (Session deletion, character changes).

**Frontend <-> Server contract**: Desktop's HTTP client (`apps/desktop/src/api/client.ts`) uses Hono's typed client over the Server's `AppType`. When adding routes, keep the route chain's returned type intact or the client loses types. Live chat goes over `/api/ws/session/:sessionId` (acks mean "accepted", not "finished"; reconnect sends current `session_state`, not missed deltas). App-wide refresh notices go over SSE `/api/system/events`, owned by the stage window and forwarded to main via Tauri.

**Native bridge**: all Tauri calls and cross-window events go through `apps/desktop/src/lib/tauri/tauriBridge.ts` with payload types in `types.ts`. A native change needs matching TS payloads, Rust arguments, and command registration. Restart the Tauri host after Rust changes; HMR does not reload native code.

**Shared settings**: business packages own their setting keys/schemas/defaults in `settings.ts` subpath entries (e.g. `@ema-agent/tools/settings`); `apps/server/src/settings/definitions.ts` collects them and is exported as `@ema-agent/server/settings`. Both Server and Desktop import these same definition objects - never repeat key strings in Desktop. These entries must stay browser-safe (no Node, SQL, or fs imports).

**Turn execution chain** (the core Agent path):
Session WebSocket -> `SessionContinuationQueue` (`turn`, in-memory input queue; merges queued input, background notices, Goal continuations) -> `TurnExecutor` (`turn`, prepares model/prompt/tools, saves messages, one Turn per Session via `SessionRunningRegistry` from `session`) -> `AgentLoop` (`agent`, model/tool loop, also runs subagents) -> TurnFanout -> Session events + optional speech.
Supporting packages: `context` (projects stored messages into model history, builds input + token estimates), `compact` (modifies the message array before each model request), `prompts` (System Prompt), `tools` (ToolPool, permission-checked execution, background Shell), `builtin-tools` (the actual tool implementations and their desktop result views), `permission`, `sandbox`, `providers` (resolves a configured capability into a connection) feeding the model API packages `llm`, `vision`, `embed`, `rerank`, `tts`, `stt`.

**Storage** (`src/storage`): three SQLite databases - `profile.db` (providers, credentials, bindings, characters, settings, MCP, Skills), `data/data.db` (sessions, turns, messages, tasks, goals, subagents, tool executions, usage, Memory jobs), `narrative/narrative.db` (fixed story data + vectors). Repositories take a connection; domain stores in other packages convert rows to public types. Session-owned files live under `data/<kind>/<sessionId>/...`, with paths from `@ema-agent/storage/dataPaths`. Profile and Data migrations are numbered SQL files in `src/storage/migrations/{profile,data}/`, each applied in one transaction; never edit an already-applied migration, add the next numbered file. Narrative installs a fixed schema + seed SQL instead.

**Other domains**: `memory` (file-based Work/Relationship Markdown memories + extraction jobs), `narrative` (story retrieval; its Embedding binding must match the fixed asset's vector space), `characters`/`stage`/`live2d-react` (character resources and presentation), `skills`, `mcp`, `backup` (`.ema-session.zip` per-session export/import), `tasks`, `goal`, `usage`, `ui` (shared React components).

Read the relevant package README before changing a domain. Module READMEs explain current responsibilities, public entry points, usage, and important contracts. Small packages do not need a mandatory reading route or a file-by-file directory tour.

## Documentation responsibilities

- Root `README.md` and `README-zh.md` explain the product, installation, operation, and demonstrations to users.
- Module READMEs explain how the current implementation is used and how its parts cooperate.
- `docs/design/` records why a design was chosen: the problem, considered alternatives, the selected approach, accepted costs and limitations, and reasons to reconsider it.
- Root `CHANGELOG.md` and `CHANGELOG-zh.md` contain Unreleased changes and concise entries for at most 30 released versions. Older release notes belong in GitHub Releases.
- GitHub Issues hold reproduction details and investigation progress. Historical local investigations are kept outside the application repository; do not recreate `docs/changes/` or use `docs/design/` as a diagnostic log.

Write English in `README.md` and Chinese in a sibling `README-zh.md`, keeping the meaning aligned. Keep `CLAUDE.md` and `AGENTS.md` entirely in English. Code comments may be written in Chinese or English. Use ASCII (English half-width) punctuation in repository-authored prose, comments, prompts, and error messages, including Chinese prose. Preserve user input, user-supplied character or Skill text, third-party content, literal test fixtures, regex characters, and external protocol data.

### Writing design decisions

Start from the problem and the decision being explained, not a package inventory. A useful design document lets a reader understand why this choice fits EmaAgent and what the project accepts in return. Use only the sections needed for that decision; do not fill a template with generic claims.

Use confirmed design discussions to establish intent. Check source and tests to establish current behavior and constraints. Code cannot establish why the author chose an approach. If the reason is not documented or confirmed, ask the user rather than inventing a motivation from the implementation.

Explain rejected alternatives when they make the current tradeoff understandable. Keep the decision and its rationale, not a transcript, assignment history, or chronological account of debugging. Separate accepted limitations from unresolved defects and proposed future changes.

For example, a computer-use design decision should explain why manual pause/resume was dropped, which interaction costs that removes, and why invalidating an old observation was accepted instead. Detailed stdin/stdout messages, file locations, and tool call chains belong in the module README and can be linked when needed.

Use Mermaid only when a comparison or consequence is easier to understand visually. A diagram should support the decision being explained. Do not substitute an implementation flowchart for the missing rationale, or describe an unimplemented option as the chosen behavior.

## Releases and versions

The workspace and CI use pnpm with `pnpm-lock.yaml`. Do not introduce another package manager's lockfile. Version-only updates do not require regenerating the dependency graph.

The root `package.json` version is the app version; `apps/desktop/package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` must match exactly - `pnpm release` checks and refuses on mismatch, never rewrites them. Git release tags and CHANGELOG version headings use a v prefix, such as `v0.1.0-beta.2`; manifest version fields remain unprefixed, such as `0.1.0-beta.2`. Keep the desktop package version in Cargo.lock synchronized. Database versions are separate integers (`user_version`), independent of app versions. `--target` must match the current host (native SQLite/Sharp/FFmpeg); no cross-compilation. Cubism Core is a licensed file the release script verifies by hash but never downloads.
