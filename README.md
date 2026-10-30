<p align="center">
  <img src="assets/icons/icon.png" width="112" height="112" alt="EmaAgent logo">
</p>

<h1 align="center">EmaAgent</h1>

<p align="center">
  <strong>A desktop character you can talk to, and an Agent that can get work done.</strong>
</p>

<p align="center">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-v0.1.0--beta.2-00ADB5?style=flat-square" alt="Version v0.1.0-beta.2"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4C9A2A?style=flat-square" alt="MIT License"></a>
  <a href="apps/desktop/README.md"><img src="https://img.shields.io/badge/Tauri-24C8D8?style=flat-square&amp;logo=tauri&amp;logoColor=000000" alt="Tauri"></a>
  <a href="apps/desktop/README.md"><img src="https://img.shields.io/badge/React-20232A?style=flat-square&amp;logo=react&amp;logoColor=61DAFB" alt="React"></a>
  <a href="tsconfig.base.json"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=FFFFFF" alt="TypeScript"></a>
  <a href="apps/server/README.md"><img src="https://img.shields.io/badge/Node.js-5FA04E?style=flat-square&amp;logo=nodedotjs&amp;logoColor=FFFFFF" alt="Node.js"></a>
  <a href="src/live2d-react/README.md"><img src="https://img.shields.io/badge/Live2D-EA7299?style=flat-square" alt="Live2D"></a>
</p>

<p align="center">
  <strong>English</strong> | <a href="README-zh.md">简体中文</a>
</p>

EmaAgent combines general-purpose roleplay with file editing, command execution, web search, and longer tasks. Give a character a persona, an illustration or Live2D model, and a voice, then use the same application for conversation, research, and work in your local projects.

It is a local-first application for one user, built with Tauri, React, and a local Node.js Server. Conversations, settings, character resources, and memories are stored on your machine. You choose which model providers to connect.

[![Conversation, wallpaper and a Live2D character on the desktop](assets/screenshots/characters/mainWindow.png)](assets/screenshots/characters/mainWindow.png)

<p align="center">
  <a href="CHANGELOG.md">Changelog</a>
  <a href="docs/README.md">Documentation</a>
</p>

## Features

### Characters and conversation

- Configure character personas, illustrations, Live2D models, voice samples, and stickers. Described stickers are available for characters to include in replies.
- Use text, image understanding, speech input, and speech output with the corresponding model setup.
- Keep separate conversations and project workspaces, with streaming replies and visible tool results.
- Maintain file-based Work and Relationship memories across conversations.

Roleplay is not limited to the bundled character or one fictional setting. A separate Narrative retrieval feature provides original story passages from the three timelines of *Magical Girl Witch Trials* when that setting is needed.

### Work with an Agent

- Read, search, write, and edit files, run commands, and inspect their output.
- Search the web and fetch pages through enabled tools.
- On Windows, observe application windows and operate available controls, mouse and keyboard. Press Esc or use the desktop overlay to end control; control also ends with its Turn. User input affecting the target invalidates old observations. Automatic screen capture skips identical frames.
- Use Tasks, Goals, and subagents for work that takes several steps.
- Queue follow-up messages while a Turn is running, or choose to guide the current Turn between iterations.
- Choose tool permission modes, compact long conversation context, and inspect recorded model usage.
- Open files, Git changes, browser tabs, and manual terminals beside the conversation.

Commands and files affect your machine. Review tool requests and use a working directory appropriate for the task. Permissions and command isolation depend on the tool, configuration, and operating system; they do not make every action harmless.

### Connect models and tools

- Configure providers and models separately for LLM, Vision, Embedding, Rerank, TTS, and STT.
- Load local and project Skills, or install Skills from SkillHub and ClawHub.
- Connect MCP servers to add tools.
- Export and import individual conversations as `.ema-session.zip` archives, including their available managed files.

Features depend on the models, tools, and local resources you enable. Local-first does not mean offline: prompts, images, tool results, or retrieved text may be sent to configured services, and requests may incur charges.

## In the application

Click a screenshot to view its full size. Expand the sections below for additional views. Screenshots show actual application states; individual task examples are not a full benchmark evaluation.

### Custom characters

Pair a character persona with an illustration or Live2D model. This conversation uses the [Hiyori Momose sample model from Live2D](https://www.live2d.com/en/learn/sample/momose-hiyori/) and a custom chat persona, with the character visible on the stage beside the conversation.

[![Hiyori Momose on the stage during a conversation about her interests](assets/screenshots/characters/hiyoriCharacter.png)](assets/screenshots/characters/hiyoriCharacter.png)

<details>
<summary>More of Hiyori's conversation</summary>

[![Hiyori's first reply with the character visible on the stage](assets/screenshots/characters/hiyoriOverview.png)](assets/screenshots/characters/hiyoriOverview.png)

[![Hiyori continuing the conversation about spending a free afternoon](assets/screenshots/characters/hiyoriConversation.png)](assets/screenshots/characters/hiyoriConversation.png)

</details>

### Character stickers

Batch-import images in character settings and describe their content and intended use. The character can select them during conversation. Images without descriptions remain in the library but are omitted from the model Prompt. Browse the grid or review descriptions in the configuration overview; the complete sticker section is limited to 80,000 characters.

Stickers appear at a compact size in chat and open at full size on click. Deleted resources may leave unavailable-image placeholders in older replies. See [Characters](src/characters/README.md#stickers).

### Longer tasks and subagents

This research example examines historical Wikipedia revisions and their cited posts. The conversation keeps the task, tool calls and subagent records together, with subagent details available beside it.

[![Research conversation with completed subagent tasks](assets/screenshots/tasks/task2Process.png)](assets/screenshots/tasks/task2Process.png)

<details>
<summary>Task overview, subagent input and research results</summary>

[![The research request and its initial tool calls](assets/screenshots/tasks/task2Overview.png)](assets/screenshots/tasks/task2Overview.png)

[![The instructions sent to a subagent beside the main conversation](assets/screenshots/tasks/task2SubagentInput.png)](assets/screenshots/tasks/task2SubagentInput.png)

[![Research result with revision IDs and citation counts](assets/screenshots/tasks/task2Result.png)](assets/screenshots/tasks/task2Result.png)

[![A subagent's returned evidence beside the main conversation](assets/screenshots/tasks/task2SubagentResult.png)](assets/screenshots/tasks/task2SubagentResult.png)

</details>

### Windows computer use

The Agent can list and observe windows, then use available controls or mouse and keyboard input to operate desktop applications. The overlay provides an end control; Esc also returns control to the user. Tool calls and results remain in the conversation.

In this example, the Agent seeks through a browser video player, observes frames and visible subtitles at several timestamps, then produces a summary.

[![Finishing computer use and summarizing the observed frames and subtitles](assets/screenshots/workspace/computerUseVideoSummary.png)](assets/screenshots/workspace/computerUseVideoSummary.png)

<details>
<summary>Window observation, player controls and timestamp-by-timestamp notes</summary>

[![The request, initial window observation and player operations](assets/screenshots/workspace/computerUseVideoStart.png)](assets/screenshots/workspace/computerUseVideoStart.png)

[![Seeking through the video player and entering fullscreen](assets/screenshots/workspace/computerUseVideoNavigation.png)](assets/screenshots/workspace/computerUseVideoNavigation.png)

[![Observations of frames and visible subtitles at several timestamps](assets/screenshots/workspace/computerUseVideoFrames.png)](assets/screenshots/workspace/computerUseVideoFrames.png)

</details>

### A workspace beside the conversation

Browse files and read their contents without leaving the conversation. Review, manual terminal and browser tabs are also available in the side panel.

[![Project files and a Markdown preview beside the conversation](assets/screenshots/workspace/workspaceFiles.png)](assets/screenshots/workspace/workspaceFiles.png)

<details>
<summary>Workspace review, tools, terminal and browser</summary>

[![Side-panel entry points for files, review, subagents, attachments, terminal and browser](assets/screenshots/workspace/workspaceTools.png)](assets/screenshots/workspace/workspaceTools.png)

[![Reviewing file changes in the side panel](assets/screenshots/workspace/workspaceReview.png)](assets/screenshots/workspace/workspaceReview.png)

The terminal and browser captures show their available interfaces before a command or page is opened.

[![A manual terminal beside the conversation](assets/screenshots/workspace/workspaceTerminal.png)](assets/screenshots/workspace/workspaceTerminal.png)

[![A browser tab with its address input beside the conversation](assets/screenshots/workspace/workspaceBrowser.png)](assets/screenshots/workspace/workspaceBrowser.png)

</details>

### Images and attachments

A message can keep multiple images together with file, pasted-text and Skill references. Larger image groups initially show two rows of thumbnails and can be expanded in the conversation history.

[![A message with 23 images folded to two rows and other attachment references beneath it](assets/screenshots/conversation/messageImagesCollapsed.png)](assets/screenshots/conversation/messageImagesCollapsed.png)

<details>
<summary>Expanded images, composer attachments and the attachment panel</summary>

[![All 23 image thumbnails expanded in the message](assets/screenshots/conversation/messageImagesExpanded.png)](assets/screenshots/conversation/messageImagesExpanded.png)

[![A composer containing 25 pending attachments and a selected Skill](assets/screenshots/conversation/attachmentDraft.png)](assets/screenshots/conversation/attachmentDraft.png)

[![The attachment panel listing an image from the conversation](assets/screenshots/conversation/attachmentPanel.png)](assets/screenshots/conversation/attachmentPanel.png)

</details>

### Follow-up inputs and permissions

Continue submitting input while a Turn is running. Queued inputs can wait for a later Turn, be removed, or be marked for delivery between iterations without interrupting an active tool.

[![Two follow-up messages queued while a tool is running](assets/screenshots/conversation/inputQueue.png)](assets/screenshots/conversation/inputQueue.png)

<details>
<summary>Pending inputs, subsequent replies and a desktop approval notification</summary>

[![One submitted input waiting for processing while another remains queued](assets/screenshots/conversation/inputQueuePending.png)](assets/screenshots/conversation/inputQueuePending.png)

[![Replies after the queued demonstration inputs were delivered](assets/screenshots/conversation/inputQueueDelivered.png)](assets/screenshots/conversation/inputQueueDelivered.png)

[![Desktop notification requesting approval for a PowerShell tool call](assets/screenshots/conversation/permissionNotification.png)](assets/screenshots/conversation/permissionNotification.png)

</details>

### Skills and MCP tools

Browse Skills from SkillHub and ClawHub, select them in a conversation, and connect MCP tools. The MCP example below shows a real call to an external server's help tool, not an email-sending operation.

[![Skills marketplace with SkillHub and ClawHub entries](assets/screenshots/extensions/skillsMarket.png)](assets/screenshots/extensions/skillsMarket.png)

[![An external MCP help call with its returned content and reply](assets/screenshots/extensions/mcpCall.png)](assets/screenshots/extensions/mcpCall.png)

<details>
<summary>Skill selection and connected MCP tools</summary>

[![Selecting a skill from the conversation menu](assets/screenshots/extensions/skillsMenu.png)](assets/screenshots/extensions/skillsMenu.png)

[![A connected MCP server and its discovered tools](assets/screenshots/extensions/mcpServers.png)](assets/screenshots/extensions/mcpServers.png)

</details>

### Per-call usage

Inspect model input/output Tokens and call duration. When the provider reports cache usage, the same record shows cache reads, writes and the read-cache rate. These are provider-reported values for individual calls, not a fixed cache-rate or cost guarantee.

[![Model usage records with Tokens, cache reads and call duration](assets/screenshots/usage/usageCache.png)](assets/screenshots/usage/usageCache.png)

<details>
<summary>Earlier calls in the same usage view</summary>

[![Earlier model calls with their Token counts, cache usage and duration](assets/screenshots/usage/usageCacheEarlier.png)](assets/screenshots/usage/usageCacheEarlier.png)

</details>

<details>
<summary>Provider dashboard usage and billing references</summary>

These DeepSeek dashboard captures aggregate usage by the selected date, API Key and hour. They can be read alongside the application's per-call records above, but do not separate usage by Session or individual task.

[![DeepSeek provider dashboard showing the morning usage period](assets/screenshots/usage/providerUsageMorning.png)](assets/screenshots/usage/providerUsageMorning.png)

[![DeepSeek provider dashboard showing the afternoon usage period](assets/screenshots/usage/providerUsageAfternoon.png)](assets/screenshots/usage/providerUsageAfternoon.png)

[![DeepSeek provider dashboard showing the later afternoon usage period](assets/screenshots/usage/providerUsageLateAfternoon.png)](assets/screenshots/usage/providerUsageLateAfternoon.png)

[![DeepSeek provider dashboard showing the evening usage period](assets/screenshots/usage/providerUsageEvening.png)](assets/screenshots/usage/providerUsageEvening.png)

</details>

### Appearance

Choose a theme hue and color presets, or configure wallpaper, fonts, corner radius and code colors.

[![Theme hue, generated shades and color presets](assets/screenshots/settings/appearancePalette.png)](assets/screenshots/settings/appearancePalette.png)

<details>
<summary>Fonts, code colors and wallpaper</summary>

[![Separate Markdown body and monospace font settings](assets/screenshots/settings/appearanceFonts.png)](assets/screenshots/settings/appearanceFonts.png)

[![Corner-radius settings and code color themes](assets/screenshots/settings/appearanceCodeStyle.png)](assets/screenshots/settings/appearanceCodeStyle.png)

[![Wallpaper preview with opacity and blur settings](assets/screenshots/settings/wallpaperOptions.png)](assets/screenshots/settings/wallpaperOptions.png)

[![The wallpaper visible behind the settings interface with adjusted opacity](assets/screenshots/settings/wallpaperOverlay.png)](assets/screenshots/settings/wallpaperOverlay.png)

</details>

## Get started

### Use an installer

Install a package built for your operating system and launch Ema. The installed `server/` directory is the application's backend, not a second application. Keep it with the installed program. Packaged builds include Node and their production dependencies; users do not need the source repository or a separate Node installation.

1. Launch Ema and open model provider settings. Select or add an LLM provider.
2. Enter the supported protocol, endpoint, and required credentials. A custom gateway's API determines its protocol, not the model name alone.
3. Add or enable the LLM model, then select the provider and model in chat.
4. Choose a character, create a conversation, and send a simple message to check that a reply completes.

Ordinary text chat does not require Embedding, Rerank, TTS, or STT setup. Verify this first, then enable capabilities individually to identify which configuration needs attention. Real requests may incur charges from the selected service.

If no model can be selected, check that the provider and model were saved and enabled. For authentication or protocol errors, check that provider's endpoint, credentials, and protocol before deleting chats or resetting data.

<details>
<summary>Model provider settings</summary>

Choose a provider preset or add your own address. The settings list LLM providers, including local service presets such as Ollama and LM Studio. Embedding, Rerank and TTS have separate provider settings; the TTS section includes a local GPT-SoVITS entry.

[![LLM provider settings with hosted and local service entries](assets/screenshots/settings/providerLLM.png)](assets/screenshots/settings/providerLLM.png)

[![Separate Embedding, Rerank and TTS provider settings](assets/screenshots/settings/providerRetrievalSpeech.png)](assets/screenshots/settings/providerRetrievalSpeech.png)

</details>

### Configure character visuals and stickers

Edit the persona in the character card, then choose a presentation:

- Illustrations: import images, select the primary resource, and assign expression emotion groups as needed.
- Live2D: import a model ZIP or directory, select the primary model, and map its existing expressions and motions.
- Blank stage: text conversations can work without a visible character.

Only configured presentation names are available. Importing an image does not assign its emotion group, and importing a model does not select it as primary. Expression changes help create a scene but do not replace the persona.

Stickers are managed separately from stage illustrations. Batch import is available; add descriptions afterward. Entries without descriptions do not enter the character Prompt. The configuration overview shows which images are ready.

Deleting a sticker can make its address in old replies unavailable. A missing-image placeholder does not mean the original is still readable. See [Characters](src/characters/README.md).

### Add capability bindings as needed

| Capability | Configuration |
| --- | --- |
| Image understanding | Use an image-capable chat model; a usable Vision binding supplies descriptions when direct image input is unavailable |
| Speech input | Configure an STT service and binding |
| Speech output | Configure a TTS service and binding, and select the character's primary reference audio |
| Long-term Memory extraction and consolidation | Configure the required Memory LLM binding |
| Narrative story retrieval | Configure its LLM, Embedding, and Rerank bindings; Embedding must match the fixed asset's vector space |

Unused capabilities can remain unconfigured. Do not replace Narrative's fixed-asset Embedding merely because another model has the same dimensions. See [Narrative](src/narrative/README.md).

### Start using speech

Reference audio needs its actual transcript and language. The recording's language and the generated reply are separate inputs. Supported combinations depend on the TTS service; do not label the recording with the desired output language.

After configuring TTS and selecting primary reference audio, enable TTS in chat and check a new Turn. Text may finish while audio continues generating and playing. The Turn does not remain running until playback ends.

Replaying an old Turn uses saved audio. Generating or regenerating makes new TTS requests. Stopping playback does not cancel generation by default. The data page's audio records let you select a usable character to generate that character's voice version from existing text, without automatically playing it.

Pacing and ownership are explained in [speech design](docs/design/speech/README.md); service parameters are in [TTS](src/tts/README.md).

### Use tools and computer control

For file work, select a clear working directory and describe the task. Availability depends on tool settings, permission mode, and the execution relationship. Permission cards explain the operation and approval scope; session allowance does not grant the same authorization to every tool.

On Windows, the Agent requests permission to start computer use. Esc or the overlay End button ends control alone, leaving the conversation able to report progress. Chat's Stop action cancels the Turn and cleans up its computer use.

Automatic screen capture has its own switch on the computer-use settings page. Ordinary text chat does not need it. When enabled, it submits frames under idle conditions and stops automatic submission during computer use. See [computer-use design](docs/design/computerUse/README.md).

### Run from source

Requirements:

- Node.js >=22. Release builds require the exact version in [release-config.json](apps/desktop/release-config.json), currently 24.13.0.
- pnpm 9.0.0, declared in [package.json](package.json).
- Rust and the Tauri build prerequisites for your operating system, described in [Desktop](apps/desktop/README.md).
- For Live2D, a properly licensed Cubism Core `06.00.0001` file at `apps/desktop/public/cubism/live2dcubismcore.min.js`.

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

Prereleases use an alpha or beta suffix, such as `0.1.0-beta.2`. Git tags and CHANGELOG version headings use a `v` prefix, such as `v0.1.0-beta.2`; version fields in package.json, Tauri, and Cargo remain unprefixed, such as `0.1.0-beta.2`. The root `package.json` sets the application release version. The Desktop package, Tauri configuration, and Cargo package must match it exactly. The release script checks all four before building and reports their values on a mismatch; it does not update versions automatically. Dependencies use pnpm and `pnpm-lock.yaml`.

Recent changes are in the [changelog](CHANGELOG.md); older release notes and installation artifacts are in [GitHub Releases](https://github.com/chengyuZou/EmaAgent/releases). Usage and design decisions are in [Documentation](docs/README.md).

Database versions are separate integers, not application release numbers. Profile and Data each start from their own `001_initial.sql` at database version 1. Future changes add the next SQL file instead of editing a released migration. Startup applies pending migrations before serving requests. A failed migration rolls back that migration, and an older application refuses a database newer than it supports. There is no automatic database downgrade.

See [Backup and upgrades](#backup-and-upgrades) for the difference between pre-migration copies and a complete data backup.

## Your data

The default application directory is `~/.ema-agent`, or `%USERPROFILE%\.ema-agent` on Windows. Set an absolute `EMA_PROFILE_DIR` to use another directory for Desktop and Server.

Development and installed builds use the same default data directory. Close one before opening the other, or set a separate `EMA_PROFILE_DIR` for testing.

| Location inside the application directory | Contents |
| --- | --- |
| `profile.db` | Providers, credentials, model bindings, characters, settings, MCP configuration, and skill indexes |
| `pre-migration/` | Database copies created before Profile or Data upgrades |
| `data/data.db` | Conversations, Turns, messages, Tasks, Goals, subagents, tool execution, usage, and Memory jobs |
| `data/attachments/`, `data/audio/`, `data/web-fetch/` | Managed images and pasted text, generated audio, and downloaded files, grouped by Session ID |
| `data/tool-results/`, `data/background-processes/`, `data/scratchpad/` | Large tool text, command output, and temporary notes, grouped by Session ID |
| `memories/` | Work and Relationship Markdown files |
| `narrative/narrative.db` | Fixed story passages, graph data, and vectors |
| `characters/`, `skills/`, and `resources/skills/` | Character resources, user Skills, and builtin Skill copies |
| `profile/models-dev.json` | Local model catalog |
| `wallpapers/`, `logs/`, and `workspace/` | Wallpapers, logs, and local working files |

Provider and MCP credentials are stored as plaintext in `profile.db`. Protect this directory and check what you share.

Ordinary file attachments refer to their original paths. Images and long pasted text are saved as managed copies. Moving an original file can break its reference.

### Backup and upgrades

For a complete backup, exit the app and copy the entire profile outside its original directory. A single-session `.ema-session.zip` export covers that Session's records and readable managed files, not all settings, credentials, characters, or Memory.

When existing databases need migration, the app first creates a pre-migration copy of the affected Profile or Data database. Server uses `<profile>/pre-migration/` by default. These database copies do not include attachments, audio, or character files, and do not automatically restore the whole application.

Installing an older app does not undo migration. Preserve current data before a manual restore and follow [Storage's recovery instructions](src/storage/README.md#migrations), including WAL/SHM handling. Session import/export is in [Backup](src/backup/README.md).

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
pnpm --filter @ema-agent/storage test
pnpm --filter @ema-agent/desktop test
```

Use the affected package's tests as well. Desktop's `test:scripts` checks release-version consistency; `pnpm test` runs workspace test tasks through Turbo. Type checking and simulated tests do not replace testing installation, native file drops, terminals, character presentation, and sound in the actual application.

For local iteration, `pnpm test:watch` watches the workspace and reruns affected build and test tasks. Package builds clear their own `dist` directories before compiling. `pnpm clean` clears these `dist` directories while preserving Rust build caches and application data.

Build and typecheck commands run at most four package tasks at once. The root test and test-watch commands run at most two package tasks, with one Vitest worker per package.

## License

The code is available under the [MIT License](LICENSE). Dependencies and bundled resources retain their own terms. Obtain the necessary rights for Cubism Core, artwork, models, and voices before redistributing them.
