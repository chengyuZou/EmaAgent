# Release documentation

[中文](./README-zh.md)

This directory keeps release notes for users and bug-fix records for maintainers. Module usage and implementation details stay in the corresponding package READMEs.

## Directory structure

```text
docs/
  README.md
  README-zh.md
  changes/
    v0.1.0-alpha.1/
      README.md
      README-zh.md
      logs/
        en/
          askUserApproval.md
          marketOperationNavigation.md
          ...
        zh/
          askUserApproval.md
          marketOperationNavigation.md
          ...
```

[changes/](./changes/) contains only version directories at its first level. Each directory holds English and Chinese release notes plus that version's investigation records. Describe the concrete behavior checked, identify the tested build when known, and distinguish passed, failed, untested and inapplicable cases. A related passing check does not close an unresolved exception.

## Versions

- [0.1.0-alpha.1](./changes/v0.1.0-alpha.1/README.md): draft release notes and the investigation index.

Each issue's evidence, current status and remaining checks belong in its log, not in a second status table here. Source checks, Dev acceptance and installed-build acceptance are different results.

## Writing release notes

Name the directory after the exact application version with a `v` prefix, such as `v0.1.0-alpha.1`. Put English release notes in `README.md` and Chinese notes in `README-zh.md`, starting with `# 0.1.0-alpha.1`. Link the two files. Mark both as drafts until that version is published, then record the release date.

Describe changes in terms of what someone using Ema will notice. Include upgrade requirements and known problems when they matter. Internal refactors do not need an entry unless they affect users. For the first release, describe the available capabilities instead of inventing an earlier version to compare against.

Use the same notes for the GitHub Release. Link to a bug record when the diagnosis is useful; keep the detailed investigation out of the release notes. The English README links to `logs/en/`, and the Chinese README links to `logs/zh/`.

## Writing bug-fix records

Place each record under its version's `logs/en/` and `logs/zh/`, using the same descriptive camelCase filename, such as `live2dReleaseRendering.md`. The language directory replaces a filename suffix. Start with the issue title, not another version heading; the directory already identifies the version. Add a language link to the matching file in `../zh/` or `../en/`.

Keep both languages aligned on symptoms, conclusions, verification and remaining work. If the same problem returns in a later version, create a record under that version and link back to the earlier evidence rather than rewriting the older version's account.

Published documentation must stand on its own. Describe verification in words instead of using private checklist IDs, and do not link to ignored local testing records or screenshots that readers cannot access.

Explain the symptom, how it was reproduced, the confirmed cause, the code change, and what was verified. Short records can use a few paragraphs. Separate a suspected cause from a confirmed one, and automated checks from installed-app checks. A code change alone is not proof that the original problem is gone.

Keep only useful error excerpts. Do not commit API keys, access secrets, user conversations, full runtime logs, or copies of a user's database. The version's `logs/` contains written bug records; the running application writes its own logs under the selected user data directory.

Use plain language and ASCII punctuation in both English and Chinese text. `README.md` is English, with its Chinese counterpart in `README-zh.md`.

## Preparing a version

The root [package.json](../package.json) sets the application release version. Update the Desktop package, Tauri configuration, and Cargo package to the same value. `pnpm release` checks all four before checking build tools, copying resources, or building. It reports their values on a mismatch and never changes versions automatically.

Use prerelease versions such as `0.1.0-alpha.1` for Alpha builds. Give each new public release a new version. A Git tag uses the same version with a `v` prefix, such as `v0.1.0-alpha.1`. Changing a Release title does not change the version embedded in an installer.

Internal workspace packages do not all need a version bump for a desktop release. Database versions track SQL schema changes and required stored-data migrations; see [Storage](../src/storage/README.md). Build and installed-app checks are described in [Desktop](../apps/desktop/README.md#build-an-installer).
