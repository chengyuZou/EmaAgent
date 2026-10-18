# EmaAgent

[中文](README-zh.md)

**A desktop character you can talk to, and an Agent that can get work done.**

EmaAgent combines general-purpose roleplay with file editing, command execution, web search, and longer tasks. Give a character a persona, an illustration or Live2D model, and a voice, then use the same application for conversation, research, and work in your local projects.

It is a local-first application for one user, built with Tauri, React, and a local Node.js Server. Conversations, settings, character resources, and memories are stored on your machine. You choose which model providers to connect.

## Features

### Characters and conversation

- Configure character personas, illustrations, Live2D models, and voice samples.
- Use text, image understanding, speech input, and speech output with the corresponding model setup.
- Keep separate conversations and project workspaces, with streaming replies and visible tool results.
- Maintain file-based Work and Relationship memories across conversations.

Roleplay is not limited to the bundled character or one fictional setting. A separate Narrative retrieval feature provides original story passages from the three timelines of *Magical Girl Witch Trials* when that setting is needed.

### Work with an Agent

- Read, search, write, and edit files, run commands, and inspect their output.
- Search the web and fetch pages through enabled tools.
- Use Tasks, Goals, and subagents for work that takes several steps.
- Choose tool permission modes, compact long conversation context, and inspect recorded model usage.
- Open files, Git changes, browser tabs, and manual terminals beside the conversation.

Commands and files affect your machine. Review tool requests and use a working directory appropriate for the task. Permissions and command isolation depend on the tool, configuration, and operating system; they do not make every action harmless.

### Connect models and tools

- Configure providers and models separately for LLM, Vision, Embedding, Rerank, TTS, and STT.
- Load local and project Skills, or install Skills from SkillHub and ClawHub.
- Connect MCP servers to add tools.
- Export and import individual conversations as `.ema-session.zip` archives, including their available managed files.

Features depend on the models, tools, and local resources you enable. Local-first does not mean offline: prompts, images, tool results, or retrieved text may be sent to configured services, and requests may incur charges.

## Get started

### Use an installer

Install a package built for your operating system and launch Ema. The installed `server/` directory is the application's backend, not a second application. Keep it with the installed program. Packaged builds include Node and their production dependencies; users do not need the source repository or a separate Node installation.

1. Open Settings and configure a provider's address, protocol, and credentials.
2. Add or enable an LLM model, then select it in a conversation.
3. Choose a character and configure its presentation.
4. Configure the additional model bindings you need for images, speech, Memory, or Narrative.

Narrative needs LLM, Embedding, and Rerank bindings. Its Embedding model must match the fixed story asset's vector space. See [Narrative](src/narrative/README.md) before changing that binding.

Development and installed builds use the same default data directory. Close one before opening the other, or set a separate `EMA_PROFILE_DIR` for testing.

### Run from source

Requirements:

- Node.js >=22. Release builds require the exact version in [release-config.json](apps/desktop/release-config.json), currently 24.13.0.
- pnpm 9.0.0, declared in [package.json](package.json).
- Rust and the Tauri build prerequisites for your operating system, described in [Desktop](apps/desktop/README.md).
- For Live2D, a properly licensed Cubism Core file at `apps/desktop/public/cubism/live2dcubismcore.min.js`.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev:start
```

The desktop host starts the frontend and local Server and passes the Server port and access secret to its windows. You do not need to configure `EMA_SHARED_SECRET` for this desktop workflow.

`pnpm dev` starts only the frontend, not the full desktop application. Rebuild packages that export compiled `dist` files after changing them. Restart the desktop host after native Rust changes; frontend hot reload does not update native code.

## Build a release

Run on the target operating system with the pinned Node version:

```sh
pnpm release
```

This builds the current backend, prepares its production files, checks startup with temporary data, and creates an installer. Defaults are NSIS on Windows, DMG on macOS, and DEB on Linux. Native dependencies are prepared on their target platform.

Installers are written under `apps/desktop/src-tauri/target/release/bundle/`. Windows uses `nsis/` by default. An explicit `--target` adds the target triple below `target/`.

Additional options:

```sh
pnpm release --bundles msi
pnpm release --cubism-core /absolute/path/to/live2dcubismcore.min.js
pnpm release --server-only
```

`--server-only` prepares and verifies the backend without creating an installer. The release script verifies the supplied Cubism Core file against the approved hash; it does not download the licensed runtime.

See [Desktop build and release](apps/desktop/README.md) for prerequisites, resources, and installed-app checks.

### Application and database versions

Release versions use three numbers: `MAJOR.MINOR.PATCH`, for example `0.1.0`, `0.1.1`, and `0.2.0`. Patch releases fix problems within a release line. Minor releases add capabilities and, while the project is below 1.0, may also change existing behavior. `0.1.11` is a valid patch number; `0.1.1.1` is not the release format used here.

The desktop package, Tauri configuration, and Cargo package must agree on the application version; the release script checks them.

Database versions are separate integers, not application release numbers. Profile and Data each start from their own `001_initial.sql` at database version 1. Future changes add the next SQL file instead of editing a released migration. Startup applies pending migrations before serving requests. A failed migration rolls back that migration, and an older application refuses a database newer than it supports. There is no automatic database downgrade.

Back up the complete application data directory while the app is closed before an upgrade. Installing an older application is not a way to undo a database migration. Details are in [Storage](src/storage/README.md).

## Your data

The default application directory is `~/.ema-agent`, or `%USERPROFILE%\.ema-agent` on Windows. Set an absolute `EMA_PROFILE_DIR` to use another directory for Desktop and Server.

| Location inside the application directory | Contents |
| --- | --- |
| `profile.db` | Providers, credentials, model bindings, characters, settings, MCP configuration, and skill indexes |
| `data/data.db` | Conversations, Turns, messages, Tasks, Goals, subagents, tool execution, usage, and Memory jobs |
| `data/sessions/` | Managed images, pasted text, audio, and command output |
| `memories/` | Work and Relationship Markdown files |
| `narrative/narrative.db` | Fixed story passages, graph data, and vectors |
| `characters/`, `skills/`, and `resources/skills/` | Character resources, user Skills, and builtin Skill copies |
| `profile/models-dev.json` | Local model catalog |
| `wallpapers/`, `logs/`, and `workspace/` | Wallpapers, logs, and local working files |

Provider and MCP credentials are stored as plaintext in `profile.db`. Protect this directory and check what you share. A conversation export is not a backup of all settings, credentials, characters, or memories.

Ordinary file attachments refer to their original paths. Images and long pasted text are saved as managed copies. Moving an original file can break its reference.

### Reset development data

Close Ema first, then run:

```sh
pnpm dev:reset
```

**This deletes every item inside the selected application data directory, including databases, conversations, custom characters, memories, credentials, logs, and workspace files. It does not create a backup.** `EMA_PROFILE_DIR` selects the target when set; otherwise the default directory is used. A development reset also affects an installed build using that directory.

The next desktop launch initializes new databases and bundled resources. Deleted custom content is not recreated.

## Documentation

The [Desktop](apps/desktop/README.md) contains the React interface and Tauri host. The [Server](apps/server/README.md) connects the business packages in `src/`. Choose a module by the feature you want to understand:

- Agent execution: [Turn](src/turn/README.md), [Context](src/context/README.md), [Tools](src/tools/README.md), [Builtin Tools](src/builtin-tools/README.md), [Permission](src/permission/README.md), [Sandbox](src/sandbox/README.md).
- Models: [Providers](src/providers/README.md), [LLM](src/llm/README.md), [Vision](src/vision/README.md), [Embedding](src/embed/README.md), [Rerank](src/rerank/README.md), [TTS](src/tts/README.md), [STT](src/stt/README.md).
- Characters and memory: [Characters](src/characters/README.md), [Stage](src/stage/README.md), [Live2D](src/live2d-react/README.md), [Memory](src/memory/README.md), [Narrative](src/narrative/README.md).
- Conversations and work: [Session](src/session/README.md), [Attachments](src/attachments/README.md), [Tasks](src/tasks/README.md), [Goals](src/goal/README.md), [Usage](src/usage/README.md), [Backup](src/backup/README.md).
- Extensions and persistence: [Skills](src/skills/README.md), [MCP](src/mcp/README.md), [Storage](src/storage/README.md), [Settings](src/settings/README.md), [Prompts](src/prompts/README.md), [Token estimates](src/token/README.md).

## Development checks

```sh
pnpm typecheck
pnpm test:scripts
pnpm test:first-start
pnpm --filter @ema-agent/storage test
pnpm --filter @ema-agent/desktop test
```

Use the affected package's tests as well. `pnpm test:first-start` builds Server and its dependencies, starts it with temporary data, and checks initialization and HTTP responses. It does not make model requests. `pnpm test` runs workspace test tasks through Turbo. Type checking and simulated tests do not replace testing installation, native file drops, terminals, character presentation, and sound in the actual application.

## License

The code is available under the [MIT License](LICENSE). Dependencies and bundled resources retain their own terms. Obtain the necessary rights for Cubism Core, artwork, models, and voices before redistributing them.
