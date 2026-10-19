# Desktop

[中文](./README-zh.md)

Ema's desktop application combines a character stage with a chat and settings window. React renders both windows. The Tauri host manages native windows, the local Server process, browser panels, terminals, file dialogs, and desktop pointer tracking.

The chat window includes session and project navigation, streaming replies and tool results, attachments, speech, and a workspace with files, Git changes, browser tabs, and terminals. Settings edit the same Server-owned providers, characters, Memory, Skills, MCP, and application parameters used during conversations.

## Run from source

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:start
```

Use the Node and pnpm requirements in the [root README](../../README.md), plus the Rust and Tauri build prerequisites for the current platform. Live2D also needs the licensed Cubism Core file described below.

Tauri starts the Server development process and Vite. Vite serves the stage at `index.html` and the main window at `main.html`, on port 1420. The Server chooses a separate local port; the host supplies that port and an authentication secret to the WebViews. Do not put the secret in a frontend configuration file.

`pnpm --filter @ema-agent/desktop dev` runs only Vite. It does not start the native host or provide native file, terminal, or browser operations.

## How data reaches the page

```mermaid
sequenceDiagram
    participant Host as Tauri host
    participant Stage as stage WebView
    participant Main as main WebView
    participant Server as Local Server
    Host->>Server: Start process
    Server-->>Host: Ready notification with local port
    Stage->>Host: Read port and secret
    Main->>Host: Read port and secret
    Main->>Server: HTTP queries and Session WebSocket requests
    Stage->>Server: System SSE subscription
    Server-->>Stage: System events
    Stage-->>Main: Forward events through Tauri
    Main->>Main: Update stores and visible views
```

- HTTP calls live in `src/api`. Hono route types describe request and response shapes; type-only Server imports do not bundle the Server implementation into the page.
- Session WebSockets send chat input and interaction responses and receive live session events. They also restore the current session's running work and pending interactions after reconnecting.
- The stage owns the system SSE connection. The main window receives forwarded events rather than opening a duplicate system subscription.
- Native calls and cross-window events go through `src/lib/tauri/tauriBridge.ts`. Payload types live beside it in `types.ts`. A native change requires matching TypeScript payloads, Rust arguments, and command registration.

The Server saves messages, settings, and resources. Frontend stores hold current navigation, drafts, loaded history, active work, and other shared page state. History is loaded in windows; live Turn data is removed only after the corresponding saved history has been loaded.

Settings pages import definitions from `@ema-agent/server/settings`, backed by [definitions.ts](../server/src/settings/definitions.ts). Server registers those same objects. `settingsApi.getValue(definition)` and `putValue(definition, value)` use the definition's key and value type, and check responses with its schema. Labels and controls stay in Desktop. Shared controls and `useSettingValues` live in `src/settings/shared`; screen capture has its own sidebar page, outside Parameter Settings.

## Session and window behavior

The main window keeps Chat and Settings mounted when switching views. Hidden views retain their dimensions and cannot receive focus. Closing the main window hides it; quitting the application stops the local Server and native terminals.

Switching sessions keeps each session's draft, workspace layout, and manual terminals. Archiving or deleting a session removes its chat state, releases its terminal views, requests PTY closure, and evicts its attachment list. Deleting one session does not clear another session's state.

Native file drops check the active page as well as pointer coordinates. Chat accepts paths only in its middle area, including a new conversation page, not the session sidebar or right workspace. A mounted but hidden Chat cannot accept a Settings drop. File selection and Chat drops share the draft attachment flow: images get a local preview, images and pasted text are saved when submitted, and ordinary files remain local path references. Dropping a file does not send the message.

The Wallpaper settings card is a separate drop target. It accepts PNG, JPEG, and WebP paths and sends their bytes through the same upload API as the file picker. Server checks the actual image format before saving. Rejected files stay rejected; they are not redirected to Chat. Other settings pages do not accept these file drops.

Project and cwd selection above the composer appears only for a new conversation. Existing sessions change project membership from the Header menu; this keeps their cwd unchanged. The title and cwd retain their separate edit actions.

The character-name link opens the shared Dialog and displays Narrative's exported full names in a table. Security settings show a short sandbox startup warning, with decoded process output in an expandable area. Expanding and collapsing use the shared transition styles.

Speech generation and playback are separate. Stopping playback does not cancel generation. Saved audio can be played from storage details without driving the character's mouth.

Live2D archive, initialization, and render failures appear on the stage with a reload button. Reloading fetches the current model again and creates a new renderer. Failures from an old archive request do not replace the current character's stage.

The stage shows startup feedback before React loads, then distinguishes Server startup from character loading. The Live2D loading indicator fades out only after the first successful render. Server and presentation failures have retry actions; missing resources show a reason, while an intentionally blank stage stays blank.

Minimizing or hiding a window does not explicitly stop the Live2D ticker. Window visibility still hides floating controls and pauses hidden-page queries. The WebView or operating system can independently throttle background frames; Ema does not promise a fixed frame rate while minimized.

Memory's storage display loads independently of previews and recent jobs. It shows measured file bytes, including internal Git data, without a capacity ring or percentage. While visible it refreshes every 30 seconds, retains the last result during refresh, and offers retry after a failure. Hiding the page pauses requests. This display does not change Memory maintenance rules.

The default profile is `~/.ema-agent`, unless `EMA_PROFILE_DIR` selects another directory. Development and installed builds can use the same profile. Installation does not provide a separate empty data directory. See the [native host documentation](./src-tauri/README.md) for resource initialization, process shutdown, logs, and platform details.

## Find the implementation

Follow the feature you are changing rather than reading every store first.

| Question | Start here |
| --- | --- |
| How do the two windows start? | `src/main.tsx`, `src/windows/main.tsx`, `src/App.tsx`, then `src-tauri/src/lib.rs` |
| How do input and attachments become a request? | `src/chat/input`, especially `submitChatDraft.ts`, then `src/api/sessionWebSocket.ts` |
| How do saved history and live replies appear together? | `src/chat/session`, `src/chat/history`, `src/stores/turn.ts`, and `src/chat/messages` |
| How do files, reviews, browser tabs, and terminals work? | `src/chat/sidePanel`, then the corresponding API or Tauri entry |
| Where are settings read and saved? | `src/settings`, `src/api/settings.ts`, and `src/stores/settings-sync.ts` |
| Where do stage expressions, speech, and input passthrough meet? | `src/stage`, `src/chat/presentation`, `src/chat/speech`, and the native window code |
| Where should a style change go? | [Styles README](./src/styles/README.md) |

## Build an installer

Use the exact Node version in [release-config.json](./release-config.json), the repository's pnpm version, and the current platform's Rust/Tauri build tools. From the repository root:

```sh
pnpm release
pnpm release --bundles msi
pnpm release --cubism-core /path/to/live2dcubismcore.min.js
pnpm release --server-only
```

The default bundle is Windows NSIS, macOS DMG, or Linux DEB. Windows installers are written to `apps/desktop/src-tauri/target/release/bundle/nsis/`.

The repository root `package.json` defines the release version. Before checking build tools or preparing files, `release.mjs` requires the Desktop `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` package version to match it. A mismatch stops the command and lists all four values without rewriting files. Release notes and bug records follow the [docs conventions](../../docs/README.md).

`--cubism-core` or `EMA_CUBISM_CORE_PATH` supplies a Cubism Core file that you have permission to distribute. Without either, the script uses `public/cubism/`. Its SHA-256 must match the approved value in `release-config.json`; the script does not download this licensed file.

`--target` must match the current Rust host because Node, SQLite, Sharp, and FFmpeg contain platform-specific files. An explicit target places bundles under `src-tauri/target/<target>/release/bundle/`. This is not a cross-compilation workflow.

The four release scripts have these roles:

1. `release.mjs` checks versions and assets, builds the current Server and its workspace dependencies, and runs the remaining steps.
2. `releaseWorkspace.mjs` prepares a temporary dependency workspace, installs locked production dependencies with a hoisted layout, and assembles ordinary files into `server/app`. It preserves required nested dependency versions and excludes pnpm's links and development command entries.
3. `releaseCheck.mjs` checks release versions and assembled files, then starts the bundled Node after the temporary dependency workspace has been removed. A fresh temporary profile verifies startup, authentication, character initialization, empty sessions, and Memory paths.
4. `releaseNativeCheck.mjs` checks SQLite story initialization, Sharp, and FFmpeg in the assembled application.

Successful checks are copied to `src-tauri/.release-staging/server/app` and `src-tauri/binaries/ema-server-<target>`. Tauri maps them into the installed resources, including the required `server` directory. These generated files should be rebuilt, not edited by hand. The repository's development dependencies and lockfile are not rewritten by release preparation.

`--server-only` still builds, installs production dependencies, and performs the standalone checks, but skips Cubism Core validation and installer creation. Server readiness may take up to 120 seconds during this check.

Installer generation is not installation or desktop acceptance testing. Before publishing, install into a real directory and check startup, exit, file drops, browser visibility, terminals, Live2D, sound, and use of an existing profile. Build-tool downloads and signing requirements can still fail independently of the Server checks.

## Verify changes

From the repository root:

```sh
pnpm --filter @ema-agent/desktop typecheck
pnpm --filter @ema-agent/desktop test
pnpm --filter @ema-agent/desktop test:scripts
pnpm --filter @ema-agent/desktop test:live2d-release
pnpm --filter @ema-agent/desktop build
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
```

`test:live2d-release` builds the actual stage, loads the bundled model and local Cubism Core under `tauri.conf.json`'s CSP, and checks the first tick and visible pixels. It uses headless Edge on Windows. On other platforms, install Playwright's Chromium first with `pnpm --filter @ema-agent/desktop exec playwright install chromium`. The test uses a temporary directory and a local HTTP server, not a user profile.

Other frontend tests use mocks for native IPC. Rust's inline tests cover resource preparation, launch logs, and Windows process termination. These checks do not replace installed-app testing. Restart the Tauri host after Rust changes; frontend HMR does not reload native code.
