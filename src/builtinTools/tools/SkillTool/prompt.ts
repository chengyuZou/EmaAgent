// SkillTool 的模型说明书:description 是唯一模型可见说明,独立成文件单点维护。

export const SKILL_DESCRIPTION = `Invoke a skill from the current Turn's available skill list.

Skills are reusable instruction packages (a SKILL.md) that tell you how to perform a specific kind of task — workflows, conventions, or domain procedures.

## When to use

- The skill listing in your context shows a skill whose description or whenToUse matches the current task — invoke it BEFORE starting the work, so its instructions guide the whole execution.
- Do not invoke a skill "just in case"; invoke it when its description clearly applies.

## Parameters

- **skill**: the skill's call name exactly as shown in the listing.
- **args**: optional free-text arguments. The skill body renders them via $ARGUMENTS.

## What you get back

The full skill instructions plus its resource root path. Follow the instructions for the rest of this turn. Files referenced by the skill (scripts, references, templates) live under the returned rootPath — read them with the file tools when the instructions say so.

## Capability narrowing

A skill may declare allowed-tools. Invoking it narrows your available tools to the intersection for the rest of this turn — it can only restrict, never grant new capabilities.

## Failure

An unknown name returns an error with the currently available skill names — pick one from that list or continue without a skill.`;
