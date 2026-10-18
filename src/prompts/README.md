# Prompts

[中文](README-zh.md)

Prompts builds the System Prompt used for conversations, manual history compaction and child Agents. It combines shared product rules with the character, permission mode, available tools and environment supplied by the caller.

## Usage

```ts
import {
  staticSystemPrompt,
  getDynamicSystemPrompt,
} from '@ema-agent/prompts';

const systemPrompt = [
  ...staticSystemPrompt,
  ...getDynamicSystemPrompt(input),
];
```

`staticSystemPrompt` is a frozen array containing one product-rules block, created when the module loads. `getDynamicSystemPrompt(input)` returns ordered dynamic blocks. A `PromptBlock` contains `content` and an optional `cacheBreakpoint`.

Context converts these blocks to system messages in the same order. The LLM package then converts those messages to the selected provider's request format.

## Where the input comes from

| Input | Current producer and meaning |
| --- | --- |
| `characterPrompt` | Character paragraphs from the active character, supplied by Server. Conversations and manual compaction include them; child Agents omit them. |
| `permissionMode` | The Session permission mode fixed for this request. |
| `toolNames` | Names from the same ToolPool used for the model's tool definitions and execution. Manual compaction supplies an empty array. |
| `environment` | Platform, Session cwd, project folders and the provider/model used for this request. A null cwd produces an explicit no-directory message. |
| `workspaceInstructions` | Workspace instructions read by Server. |
| `skillCatalog` | Text produced by `renderSkillListing` for the selected SkillPool. |
| `memorySection` | Memory usage guidance. Actual Memory and Task facts are supplied separately through the persisted Turn reminder. |

The optional text fields and character paragraphs are copied as supplied. Their original punctuation is preserved. Product-owned prose, headings and environment labels use ASCII punctuation.

The production paths are:

- [Turn preparation](../turn/prepare/prepareContextInput.ts) builds the conversation prompt and the idle context estimate from the same inputs.
- [Manual compaction](../commands/compact/compactSession.ts) reads the current character and Session inputs, then builds system messages with no tools.
- [Child Agent preparation](../turn/prepare/prepareSubagent.ts) reuses the parent Turn's already-read workspace, Memory and Skill text, substitutes the child's actual model and tool names, omits the character and appends its delegation rules.

## Order and caching

The resulting sequence is:

1. Shared product rules and external-content trust guidance.
2. Workspace instructions, when supplied.
3. Memory usage guidance, when supplied.
4. Skill catalog, when supplied.
5. Character paragraphs and historical-speaker guidance, when a character is supplied.
6. Permission-mode guidance.
7. Guidance for the actual tool pool.
8. Platform, working directory, project folders and current model.

Blank optional blocks are omitted. An empty tool pool still produces a short generic capability block.

The character's paragraphs and historical-speaker guidance stay in one block. Historical name prefixes identify earlier speakers; they do not instruct the model to change character. Omitting the character also omits this guidance.

Only the shared static block has a cache marker here. Context preserves that marker and separately marks the final non-empty request message. The Anthropic protocol converts these hints into provider cache markers; other current protocols ignore them. Stable text is placed first to keep an identical prefix where possible, but cache reuse is determined by the provider.

## Product and tool rules

[productPrompt.ts](productPrompt.ts) contains identity, task execution, safety, tool selection, communication and tone rules. The product name EmaAgent is distinct from the active character's identity. Conversation, discussion, investigation and execution share these rules; the user's request and actual permission mode determine which actions are appropriate.

[systemPrompt.ts](systemPrompt.ts) assembles the static and dynamic blocks. Plan guidance describes read-only investigation and planning. Tool-pool selection and execution-time permission checks enforce that policy outside this package.

Detailed capability guidance is generated from actual tool names in `@ema-agent/builtin-tools/identity`. It explains tool selection and cooperation, while individual tools provide their own parameter and result contracts. A visible name permits an attempted call; required bindings or execution conditions may still be missing.

The rules were informed by the Intro, System, Doing tasks, Actions, Using tools, Communication and Tone sections of Claude Code's `src/constants/prompts.ts`, and describe this project's behavior.

## Verification

Run:

```sh
pnpm --filter @ema-agent/prompts test
pnpm --filter @ema-agent/prompts typecheck
```

[systemPrompt.test.ts](tests/systemPrompt.test.ts) checks output order, optional inputs, static cache marking, character and permission guidance, actual-tool selection, ASCII punctuation in generated text and preservation of caller-supplied text.
