# Documentation

[中文](./README-zh.md)

See the [project README](../README.md) for installation and demonstrations, and the [changelog](../CHANGELOG.md) for recent changes.

## User guide

- [Get started in the root README](../README.md#get-started): text-model setup, character resources, optional capabilities, and speech; the data section covers backups and upgrades.

## Read by task

- [Desktop](../apps/desktop/README.md): development, builds, releases, and frontend responsibilities.
- [Native desktop](../apps/desktop/src-tauri/README.md): windows, notifications, native commands, and process lifecycle.
- [Characters](../src/characters/README.md): personas, Live2D, illustrations, reference audio, and stickers.
- [Computer use](../src/computer-use/README.md): Node/native communication, ownership, and ending control.
- [Turn](../src/turn/README.md) and [Tools](../src/tools/README.md): conversation execution and tool scheduling.
- [Memory](../src/memory/README.md) and [Narrative](../src/narrative/README.md): long-term memory and story retrieval.
- [Storage](../src/storage/README.md): databases, migrations, and pre-upgrade copies.

## Design decisions

These documents explain why choices were made, what alternatives were considered, and which costs and limitations we accept. Module READMEs cover usage and implementation contracts.

- [Computer use](design/computerUse/README.md): dropping automatic pause and ending control with its Turn.
- [Memory](design/memory/README.md): editable text instead of a graph, and active-date retention.
- [Story retrieval](design/narrative/README.md): LightRAG selection, preserving query intent, and retrieval cost.
- [Input queue](design/inputQueue/README.md): unified delivery, guidance, and confirming saved input.
- [Speech](design/speech/README.md): generation, playback ownership, voice versions, and the beta's pacing choice.
- [Stage](design/stage/README.md): giving static illustrations emotion mappings for a Galgame-like scene.
- [General knowledge base](design/knowledgeBase/README.md): removing KB in favor of existing file tools until concrete demand appears.
- [History branches](design/sessionBranches/README.md): deferring branches within a Session because derived work needs clear ownership.
- [Character switching](design/characterSwitch/README.md): marking boundaries in TurnReminder without rewriting old assistant messages.
- [Media budget](design/mediaBudget/README.md): sharing a budget across sources and omitting older content first.
- [Permission decisions](design/permissions/README.md): centralizing decisions and making user approval scopes explicit.
- [Complete LLM results](design/llmCompletion/README.md): collecting a CallLLM stream internally to address native non-streaming restrictions.

## Where content belongs

| Location | Purpose |
| --- | --- |
| Root README | User capabilities, installation, operation, and actual screenshots |
| Root CHANGELOG | Unreleased changes and concise notes for at most 30 recent released versions |
| Module READMEs | Current responsibilities, entry points, normal flow, and important constraints |
| docs | Usage guides, design rationale, accepted tradeoffs, and current limitations |
| GitHub Issues | Reproduction steps, environment, logs, and resolution progress |
| GitHub Releases | Version-specific release notes and installation artifacts |
| assets/screenshots | Original demonstration images and their usage index |

Design documents may explain why a solution was chosen, what it does not cover, and what evidence would justify revisiting it. Retain abandoned approaches only when they explain a current tradeoff; do not present them as available features. Full process dumps and one-off experiment outputs do not belong in user documentation.

Describe current implementation and distinguish automated checks, manual Dev verification, and installed-build verification. Use README.md for English and a sibling README-zh.md for Chinese. Issue fields use English / Chinese labels; ordinary reporters are not asked to upload entire databases.

Historical investigations and experiment outputs are kept outside this repository. They are not required to build or run the application. New issue progress belongs in GitHub Issues; design documents retain the reasons and evidence relevant to a decision.
