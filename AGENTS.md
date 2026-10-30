# EmaAgent Working Agreements

EmaAgent is a local-first desktop Agent for one user. It includes characters and a Live2D stage, conversations and tool execution, file-based long-term Memory, separate Narrative story retrieval, Skills, and MCP. See [README.md](README.md) and [README-zh.md](README-zh.md) for its purpose and setup. [CLAUDE.md](CLAUDE.md) contains additional repository commands and code navigation notes.

## Communication and scope

Use plain language. State who reads or saves what, when an operation stops, and why it fails. Do not replace an explanation with impressive-sounding labels. For example, instead of "backpressure bounds the input backlog", write "when the receiver cannot keep up, stop reading more input and resume when it can accept more".

- The current user request and decisions confirmed for the task define the scope. This file does not choose the next module or a fixed work order.
- TODOs and design documents are leads, not instructions to start work. Check the code, data, and running behavior rather than treating an old plan as a current fault.
- When asked to discuss, diagnose, review, or list work items, answer that request first. Change business code only when implementation is authorized.
- If a key fact is unknown, there is a material design disagreement, or a name would change the business meaning, explain the issue and ask before deciding.
- Preserve decisions and authorization already given for the task. Do not repeatedly ask the user to approve the same unchanged scope.

## Before making changes

- Read the implementation, actual producers, transfer boundaries, consumers, and relevant tests. Trace the necessary call chain; do not conclude from a filename or one search.
- Explain the current behavior, problem, scope, and expected result before editing.
- Inspect Git status, diffs, or recent commits only when the user explicitly asks. Preserve the user's and other agents' uncommitted changes.
- Prefer `rg` for file searches and `apply_patch` for text edits. Do not stage, commit, create tags, push, reset, or perform destructive cleanup without explicit authorization.
- Do not read or modify a real user's database as a substitute for testing. Confirm the target and scope before operating on existing data. Use temporary directories or in-memory databases for tests.
- Read the relevant module README before changing a package. Check its claims against the implementation when they affect the task.

## Design and implementation

- Handle one main business boundary per batch. Once a refactor is agreed, update all real callers and tests to the final meaning. Do not keep unused old entry points, duplicate writes, or compatibility code only for disposable development databases.
- Every field and interface needs a clear meaning, producer, and real consumer. Test-only use is not a reason to keep it. Discuss uncertain or unused public fields with the user before removing them.
- Express known fields with explicit types, interfaces, or SQL columns. Do not hide fixed business fields in generic JSON, `opts`, `this.opts`, `meta`, `metaJson`, or `Record<string, unknown>`. Represent genuinely open external protocols according to their actual shape.
- Group files by related responsibilities, not line counts or a uniform template. A complete business implementation may be long. Do not scatter small files that have no independent purpose.
- Do not add a Facade, Manager, Service, Port, registry, `common`, or `utils` for an imagined second implementation. Judge existing names by their actual use rather than renaming them mechanically.
- Name interfaces and fields after the business they represent. `Runtime`, `snapshot`, and `facade` must not replace a specific responsibility. Use established third-party or domain terms when they accurately describe the code.
- Frontend code reading backend facts should use shared business types or inferred route types. Do not duplicate equivalent fields, state machines, settings, or shared limits. Network requests go through `api/**`; Tauri IPC goes through named entry points.
- Check the actual shape of JSON, SSE, WebSocket, IPC, and SQL boundaries, including names, units, nullable values, and the order of saving and notifying.
- Stores hold genuinely shared or changing state and have explicit refresh triggers. Do not create a Store just to forward an API call or cache an ordinary query.
- Consider Windows, macOS, and Linux. Do not assume installed users have the source repository, a developer's Bash, Node, or Python.

## Keep only designs with a current use

- Before adding a field, interface, file, or check, identify who produces it, who consumes it, and which supported path would break without it. If there is no answer, do not add it.
- Validate user input, external APIs, untrusted content, and cross-process messages as needed. Do not repeatedly validate data just produced internally; fix its construction when a guarantee is required.
- Decide whether a dangerous operation needs permission before approval. Do not block the same approved operation again using guessed risks. This single-user local application is not a multi-user SaaS.
- Do not add protocol discriminators or general extension frameworks without a real second implementation. Development databases can be reset; do not prebuild compatibility reads or duplicate writes for them.
- Add a hash or fingerprint only when it replaces substantially more expensive work and its comparison changes the next action.
- Diagnostic, observation, and log fields need a current consumer such as UI, an alert, or recovery. Do not retain unused fields just for possible future debugging.
- When removing an unused implementation, remove it directly rather than adding another compatibility wrapper.

## Code style and frontend work

- TypeScript packages using NodeNext retain `.js` suffixes on relative imports. Put ordinary imports at the top. Explain dynamic imports where platform or startup requirements make them necessary.
- Use camelCase for new filenames and PascalCase for types and main components. Put tests in the module's `tests/` directory.
- Keep LLM, TTS, and STT uppercase in identifiers, not Llm, Tts, or Stt. Entirely lowercase identifiers such as `llm`, `tts`, and `stt` are fine. Vision and Rerank do not need all capitals.
- Do not compress several steps onto one line. Keep TSX props and conditional rendering readable. Allow at most one level of ternary expressions; use if/else or switch for more complex choices.
- Read one or two comparable components before writing frontend code. Reuse `@ema-agent/ui` components when they support the required interaction instead of recreating them with native elements.
- Treat loading, failure feedback, keyboard focus, scrolling, and transitions as product behavior. When adding an animated interaction, handle both entering and leaving states.

## Repository commands and build behavior

This is a pnpm 9 workspace using Turbo, with business packages under `src/*` and applications under `apps/*`. Development requires Node 22 or newer and Rust 1.90 or newer. Release builds use the exact Node version recorded in `apps/desktop/release-config.json`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev:start
pnpm typecheck
pnpm test
```

`pnpm dev:start` runs the full desktop application. `pnpm dev` starts Vite without the native desktop or Server. `pnpm dev:reset` deletes the active profile's data; do not run it without explicit authorization for that target.

Business package imports generally resolve compiled `dist` output. After editing a package, rebuild it and the affected dependencies before checking a consuming application. A focused package test does not automatically rebuild its dependencies. For example:

```sh
pnpm --filter "@ema-agent/turn..." build
pnpm --filter @ema-agent/turn typecheck
pnpm --filter @ema-agent/turn test
```

The storage build copies SQL migrations into `dist/migrations`; keep this step in release assembly. Verify that a script and its referenced files exist before presenting it as an available check. The root `test:first-start` and `test:scripts` commands currently reference missing files under `scripts/tests/`; Desktop's release-script tests are available through `pnpm --filter @ema-agent/desktop test:scripts`.

## Documentation, comments, and prompts

### Language and punctuation

- Write `README.md` in English and place Chinese documentation in a sibling `README-zh.md`. Link the two. Write `AGENTS.md` and `CLAUDE.md` entirely in English.
- Code comments may be written in Chinese or English. Use ASCII (English half-width) punctuation in repository-authored documentation, comments, prompts, error messages, and explanatory text, including Chinese prose.
- Do not use these rules to rewrite user input, user-supplied character or Skill text, third-party content, literal test fixtures, regex characters, or external protocol data.
- Call one conversation execution a Turn. Do not introduce a "root Turn". Distinguish the main Agent and subagents by their actual execution relationship.

### Comments

- Explain reasons, contracts, and constraints that are not obvious from code: ordering, paired operations, cancellation, failure, concurrency, units, and the business meaning of null or undefined.
- Put a comment beside the relevant declaration or logic. Name the concrete object and the consequence of violating a constraint rather than just saying "be careful" or "do not change".
- Do not translate code line by line or repeat function names, parameter types, or obvious operations. Prefer clear names and structure when they can express the meaning.
- Remove decorative file headers, dividers, and numbered headings. Keep a short header only for important ordering, platform restrictions, or special responsibilities that the file and its name do not explain.
- Preserve licenses, necessary attribution, generated markers, and lint/typecheck directives. Necessary declaration JSDoc is not a decorative header just because it appears first.
- Public declarations do not each need JSDoc. Explain field semantics beside the field. Do not use `@param` for interface fields or maintain a second field inventory.
- Tests normally explain behavior through describe and it. Add comments only for non-obvious environment needs, reproduction conditions, or ordering.
- Do not record conversation history, work assignments, completion reports, or comparisons claiming to copy another product's behavior. Preserve necessary external product names, integration paths, protocols, and attribution.
- Describe concrete operations instead of vague metaphors. Established terms such as transaction, projection, cursor, and snapshot are fine when used in their actual technical meaning.
- Do not promise unverified accuracy or make unsupported absolute claims. TODOs describe specific unresolved problems and affected behavior, not completed work or assignments.

### Where documentation belongs

- The root README is for project users. Explain the purpose, available capabilities, installation, operation, and links to module documentation.
- Module READMEs describe current responsibilities, public entry points, usage, main flow, and important constraints, based on source and tests. Avoid long lists of what a package does not do. Do not present planned features as implemented.
- `docs/design/` explains why a design was chosen: the problem, considered alternatives, the selected approach, and accepted costs and limitations. Code establishes behavior, not the author's motivation. Ask about unknown reasons instead of inventing them.
- Root CHANGELOG files hold Unreleased changes and concise notes for at most 30 released versions. Older release notes belong in GitHub Releases. Reproduction details and ongoing investigations belong in GitHub Issues; do not recreate `docs/changes/` as an investigation archive.
- Simple packages do not need a reading route or complex data-flow section. Do not translate a directory listing file by file or copy full type definitions and large implementations.
- Explain the normal flow before important cancellation, failure, and concurrency branches. Keep local contracts beside declarations and cross-file cooperation in the README. Link to a shared rule rather than copying it repeatedly.
- Add a diagram only when it makes a real relationship easier to understand. Use sequence diagrams for waits and notifications, flowcharts for branches, state diagrams for state changes, and tables for field mappings.
- Match diagram names to actual entry points, events, and states. Show important saving and notification order. Do not maintain fragile source line numbers, file lengths, or complete call trees.
- Update examples, defaults, and diagrams with behavior changes. Describe stable behavior directly rather than preserving a refactor timeline.

## Checking packages and documentation

- Check one package and its files at a time, including implementations, actual callers, and tests, before cleaning comments and documentation.
- Distinguish redundant comments, inaccurate wording, missing contracts, and useful diagrams. Do not replace inspection with regex-based header removal or repository-wide terminology replacement.
- Documentation cleanup does not authorize business changes, public-field removal, or interface renaming. Explain discovered problems and ask about material design decisions.
- Write the README after the public interface is settled. Resolve conflicting local documentation while checking that package.

## Verification and delivery

- Match verification to risk. Check database results for storage, requests and responses for APIs, real processes for process boundaries, and actual pages for frontend interaction and layout.
- Type checking does not replace runtime verification. Creating an installer does not replace installing and using it.
- Reuse meaningful existing tests. Add tests for behavior or regressions that need them, not to mirror the implementation or justify a documentation-only change. Do not generate large test suites for reversible, low-impact edits.
- Test with temporary directories or in-memory databases. Explain configuration requirements and possible costs before testing real models or paid network calls.
- Rebuild and restart the native desktop after changing native windows or Tauri behavior. Frontend HMR does not update running Rust code. Do not report an old running process as verification of new native behavior.
- Visual hierarchy, animation, and interaction feedback are product behavior, not decoration to postpone indefinitely.
- Clearly separate verified results, unverified behavior, and decisions still needed from the user. Do not report tests or installed-app checks as passed when they were not run.

## Releases, versions, and shared icons

- Git release tags and CHANGELOG version headings use the `v` prefix, such as `v0.1.0-beta.2`. Manifest version fields use bare SemVer, such as `0.1.0-beta.2`.
- Keep the root `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, and the desktop package in `apps/desktop/src-tauri/Cargo.toml` consistent. Synchronize the desktop package entry in Cargo.lock. The release script checks the application manifests and both root version fields in `package-lock.json` without rewriting them.
- The workspace and CI use `pnpm-lock.yaml` for dependencies. The retained `package-lock.json` must have its top-level `version` and `packages[""].version` synchronized with the root package version. Do not regenerate npm dependencies as part of a version-only update.
- Database migration versions are separate integers. Do not rewrite already-applied migrations as a routine app-version update; follow the supported upgrade path and the user's confirmed scope.
- Build native release dependencies on the target platform. Read `apps/desktop/README.md` and the release configuration before assembling a release. Keep the licensed Cubism Core requirement intact.
- Shared application icons live in `assets/icons/`. `iconSource.png` is the selected artwork; `icon.png`, `icon.ico`, and `icon.icns` are generated for their consumers. Preserve transparency and regenerate formats from the selected source when changing the icon. Native executables need rebuilding to embed the change.
- Do not publish a release, upload artifacts, or create a release tag unless the user authorizes it. Report whether the work only updated sources, built artifacts, or also verified an installed application.
