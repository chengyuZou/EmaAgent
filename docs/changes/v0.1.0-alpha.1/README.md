# 0.1.0-alpha.1

[中文](./README-zh.md)

Status: Draft, not published. Installer acceptance testing is still pending.

This Alpha brings character conversation and local Agent work together in one desktop application. It requires configured model providers for model-backed features.

## Available capabilities

- Create characters with a persona, an illustration or Live2D model, and reference audio.
- Keep separate conversations and projects, attach files and images, and read streaming replies and tool results.
- Let the Agent work with files, commands, web searches, Tasks, Goals, and subagents, subject to the selected permissions.
- Open files, Git changes, browser tabs, and terminals beside a conversation.
- Configure LLM, Vision, Embedding, Rerank, TTS, and STT models, and add tools through Skills and MCP.
- Keep file-based long-term Memory and use separate Narrative retrieval for the bundled story setting.
- Export and import individual conversations with their available managed files.

## Included fixes

- Live2D can load under the release build's content security policy without enabling JavaScript `unsafe-eval`. [Bug record](./logs/en/live2dReleaseRendering.md).
- Minimizing or hiding the stage no longer makes Ema explicitly stop the Live2D ticker. Floating controls still follow window visibility.
- File trees, Diff views and terminals can apply their runtime styles in the release build. Markdown network images are permitted, with local and network audio playback retained. [Bug record](./logs/en/releaseUiStyles.md).
- Both application windows have permission to change their native theme. Installed Server startup uses the production Node environment. [Bug record](./logs/en/releasePermissionsAndEnvironment.md).
- Selecting "Follow system" releases the previous light or dark window override instead of treating that override as the system preference. [Bug record](./logs/en/releasePermissionsAndEnvironment.md#follow-system-theme-regression).
- Windows process cleanup now suppresses the cleanup command's console window. The user confirmed full exit without the reported flash in the tested Windows installer. [Bug record](./logs/en/windowsExitConsole.md).
- Skills installations and MCP market additions keep their in-progress state when switching settings pages, including concurrent operations. Source checks and Dev acceptance passed; installed-build acceptance remains pending. [Bug record](./logs/en/marketOperationNavigation.md).

Screen capture settings have a dedicated sidebar page with the existing automatic-capture switch, interval and privacy notice.

## Before using this Alpha

- Install a package built for your operating system and CPU architecture. A Windows `.exe` is not a macOS or Linux installer.
- Model-backed features require the corresponding provider and model bindings. External requests may incur charges.
- Development and installed builds use the same default user data directory. Close one before starting the other, or use a separate `EMA_PROFILE_DIR` for testing.
- A consolidated installed-build regression remains pending after the current fixes. Earlier user checks passed basic Windows installation, repeated startup, overwrite of the tested build and exit, but do not establish every upgrade path. Back up existing data before testing an upgrade. Reinstalling an older application does not undo database migrations.

## Investigation records

These records keep the evidence and remaining checks separate from the release summary. The exact earlier installer identifier was not recorded; a Dev pass does not replace the consolidated installed-build regression.

- [Market operation state across settings navigation](./logs/en/marketOperationNavigation.md)
- [AskUser approval before questions](./logs/en/askUserApproval.md)
- [Live2D rendering in release builds](./logs/en/live2dReleaseRendering.md)
- [Release UI styles and Markdown media](./logs/en/releaseUiStyles.md)
- [Native theme permissions and Server environment](./logs/en/releasePermissionsAndEnvironment.md)
- [Console flash when exiting on Windows](./logs/en/windowsExitConsole.md)
- [Unrelated WebSearch results](./logs/en/webSearchResults.md)
