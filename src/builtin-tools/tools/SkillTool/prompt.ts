// SkillTool 的模型说明书:description 是唯一模型可见说明,独立成文件单点维护。

export const SKILL_DESCRIPTION = `Invoke a skill from the current Turn's available skill list.

Skills are reusable instruction packages (a SKILL.md) that tell you how to perform a specific kind of task — workflows, conventions, or domain procedures.

## When to use

- The skill listing in your context shows a skill whose description or whenToUse matches the current task — invoke it BEFORE starting the work, so its instructions guide the whole execution.
- Do not invoke a skill "just in case"; invoke it when its description clearly applies.

## Parameters

- **name**: the skill name exactly as shown in the listing.
- **path**: the absolute SKILL.md path exactly as shown in the listing. The path is the skill identity.

## What you get back

The full skill instructions plus its path. Follow the instructions for the rest of this turn. Relative resources live beside SKILL.md.

## Capability narrowing

A skill may declare allowed-tools. Invoking it narrows your available tools to the intersection for the rest of this turn — it can only restrict, never grant new capabilities.

## Failure

An unknown name returns an error with the currently available skill names — pick one from that list or continue without a skill.`;
