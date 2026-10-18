# Skills

[中文](./README-zh.md)

This package discovers SKILL.md files, keeps a searchable skill directory, applies enablement settings for each Turn, and installs skills from SkillHub and ClawHub.

## Identity and entry points

A skill is identified by the absolute path of its SKILL.md file. Names are display labels and may repeat. Frontmatter provides name, optional version, description, and optional when-to-use. Reading the skill directory does not load the instructions into the model.

- Construct `SkillStore(profileDb, userRoot, builtinRoot)` to scan local directories, save their indexes and enablement, finish installations, and delete local skills.
- Create a registry with `createSkillRegistry({ store })`. Call `refreshCore` at startup before reading it. It reads builtin and user skills; `list(folderPaths)` also discovers project skills for the given folders.
- `freezeSkillPool` filters disabled paths and project sources, sorts by scope, name, and path, then builds a path lookup for the Turn.
- `renderSkillListing` builds the system-prompt directory. The Skill tool uses the same pool to find a path and reads its full SKILL.md when called.
- `createMarketService` provides market lists, details, file previews, and source status. `createMarketInstaller` installs and uninstalls market skills.

```ts
const registry = createSkillRegistry({ store });
await registry.refreshCore();
const entries = await registry.list(folderPaths);
const pool = freezeSkillPool({
  entries,
  disabledPaths: store.listDisabledPaths(),
  disabledProjectSources: [],
});
const listing = renderSkillListing(pool);
```

The host reads `disabledProjectSourcesSetting` for the real disabled-source list. `workspaceInstructionFilesSetting` selects workspace instruction files from CLAUDE.md and AGENTS.md, in that order.

## Discovery and Turn use

| Scope | Content location | Index and enablement |
| --- | --- | --- |
| builtin | Profile-local copy of bundled skills | Profile SQLite skills table |
| user | User skill directory, including market and manually placed skills | Profile SQLite skills table |
| project | Current project folders' .agents/skills, .claude/skills, .codex/skills, .cursor/skills, .gemini/skills | In-memory directory cache; project-source settings |

Builtin and user scans inspect direct child directories. A rescan updates metadata while retaining existing enabled and installed_at values. Invalid skills are omitted from the returned directory but keep their index and toggle; a missing directory removes its index. A root read failure does not mean that every skill has been deleted.

The registry serializes core rescans. Reads wait for the first core load, but do not wait for later rescans. Project results are cached by the folder list and change on `refreshProjectFolders`. Project scanning skips hidden entries and symbolic links, searches to depth 6, and visits at most 2,000 directories per ecosystem root. Folder scans use up to 5 concurrent tasks and file parsing up to 16.

Server chooses all folders of a Session's project, or its cwd when there is no project. A project with no folders adds no project skills. Settings routes, Turn preparation, and manual compact use this selection.

The pool fixes the available directory for one Turn. Installing or disabling a skill affects the next Turn. The pool does not copy file contents: the Skill tool reads the current file when called. Prompt entries use name, path, description, and whenToUse. Descriptions are limited to 250 UTF-16 code units; entries have an 8 KiB UTF-8 budget, followed by an omission notice when needed. Separating newlines and the notice are additional text, so this is not a strict bound on the returned string.

A selected skill is saved in Session messages as `{ type: 'skill_reference', name, path }`. The name supports history display; the path is checked against the current pool. The Skill tool returns full SKILL.md, including frontmatter, and its resource directory. It does not freeze the file on disk.

## Installation and deletion

Market lists merge both sources, remove repeated identities and matching mirrors within the current result batch, then sort by downloads. Installation status is checked against the current local directory and its .ema-market.json identity marker on each request.

Market data has a process-local cache: lists 5 minutes, searches 2 minutes, details 10 minutes, previews 30 minutes, at most 500 entries. List and detail failures may return stale data with source status. ClawHub search has no next-page cursor and is capped at 50 results. The combined cursor keeps the remaining position of each source.

Installation reads a fresh file list, validates portable relative paths, checks sizes and available SHA-256 values, then writes text files to a temporary directory inside userRoot. Limits are 200 files, 5 MiB per file, and 20 MiB in total. A valid SKILL.md and the source marker must be written before `finalizeInstall` replaces the target directory and saves its index. Enablement is preserved when replacing an existing index. The replacement deletes the target before renaming, so it is not a rollback transaction if the rename fails.

Downloads for different skills can proceed together; duplicate installs of the same source and slug are rejected. Cleanup removes the temporary directory on completion or failure. Startup uses `sweepOrphanStaging` to remove interrupted installations. Market uninstall requires a matching source marker. Local builtin/user deletion separately checks that the target is a direct ordinary directory within the configured root. Deleting a builtin skill removes only its profile copy and keeps the root directory, so ordinary restart does not seed it again.

Server routes refresh the registry after installation or deletion, then emit `skills_changed`. Toggle and rescan routes also emit it. The event carries no directory data; open Desktop views query the current directory again.

## Reading and verification

Read `registry.ts` and `skillPool.ts` for directory lifetime and Turn selection, `store.ts` for filesystem and index updates, and `sources/project.ts` for project scanning. Market browsing is in `sources/market/marketService.ts`; installation is in `installService.ts`. HTTP consumers are under `apps/server/src/routes/skills`, and the model consumer is `src/builtin-tools/tools/SkillTool`.

Run `pnpm --filter @ema-agent/skills test`. Tests use temporary directories and real profile SQLite databases for scans, toggles, local installation and deletion, registry refresh, and stored-enablement migration. Project tests cover multiple folders, hidden directories, depth, and symbolic links where the OS permits creating them. Market tests check duplicate identities and local installation markers with simulated sources; they do not validate live upstream downloads or a complete remote installation.
