# Release documentation

[中文](./README-zh.md)

This directory keeps release notes for users and bug-fix records for people maintaining Ema. Module usage and implementation details stay in the corresponding package READMEs.

## Directories

| Directory | Contents |
| --- | --- |
| [changes/](./changes/) | One Markdown file per application version, describing what users gain, what was fixed, and anything they need to know before upgrading. |
| [logs/](./logs/) | Bug-fix records named after the problem. Each record uses a level-one heading to identify the application version containing the fix. |

Start with the [0.1.0-alpha.1 draft](./changes/0.1.0-alpha.1.md). Bug records cover [Live2D release rendering](./logs/live2dReleaseRendering.md), [release UI styles and Markdown media](./logs/releaseUiStyles.md), [native permissions and Server environment](./logs/releasePermissionsAndEnvironment.md), and the [Windows exit console](./logs/windowsExitConsole.md).

## Writing release notes

Name the file after the exact application version, such as `0.1.0-alpha.1.md`, and start with `# 0.1.0-alpha.1`. Keep one file per version. Mark it as a draft until that version is published, then record the release date.

Describe changes in terms of what someone using Ema will notice. Include upgrade requirements and known problems when they matter. Internal refactors do not need an entry unless they affect users. For the first release, describe the available capabilities instead of inventing an earlier version to compare against.

Use the same notes for the GitHub Release. Link to a bug record when the diagnosis is useful; keep the detailed investigation out of the release notes.

## Writing bug-fix records

Use a descriptive filename, such as `live2dReleaseRendering.md`, rather than a version filename or a separate version directory. Start each version's account with a heading such as `# 0.1.0-alpha.1`. If the same problem returns in a later version, add another version heading to the same file.

Explain the symptom, how it was reproduced, the confirmed cause, the code change, and what was verified. Short records can use a few paragraphs. Separate a suspected cause from a confirmed one, and automated checks from installed-app checks. A code change alone is not proof that the original problem is gone.

Keep only useful error excerpts. Do not commit API keys, access secrets, user conversations, full runtime logs, or copies of a user's database. `docs/logs/` contains written bug records; the running application writes its own logs under the selected user data directory.

Use plain language and ASCII punctuation in both English and Chinese text. `README.md` is English, with its Chinese counterpart in `README-zh.md`.

## Preparing a version

The root [package.json](../package.json) sets the application release version. Update the Desktop package, Tauri configuration, and Cargo package to the same value. `pnpm release` checks all four before checking build tools, copying resources, or building. It reports their values on a mismatch and never changes versions automatically.

Use prerelease versions such as `0.1.0-alpha.1` for Alpha builds. Give each new public release a new version. A Git tag uses the same version with a `v` prefix, such as `v0.1.0-alpha.1`. Changing a Release title does not change the version embedded in an installer.

Internal workspace packages do not all need a version bump for a desktop release. Database versions change only when their SQL structure changes; see [Storage](../src/storage/README.md). Build and installed-app checks are described in [Desktop](../apps/desktop/README.md#build-an-installer).
