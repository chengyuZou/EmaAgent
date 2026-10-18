export const SKILL_DESCRIPTION = `Invoke a skill from the current Turn's available skill list.

Skills are reusable instruction packages (a SKILL.md) that tell you how to perform a specific kind of task  -  workflows, conventions, or domain procedures.

## When to use

- The skill listing in your context shows a skill whose description or whenToUse matches the current task  -  invoke it BEFORE starting the work, so its instructions guide the whole execution.
- Do not invoke a skill "just in case"; invoke it when its description clearly applies.

## Parameters

- **name**: the skill name exactly as shown in the listing.
- **path**: the absolute SKILL.md path exactly as shown in the listing. The path is the skill identity.

## What you get back

The full SKILL.md, including its frontmatter, plus its path. Follow the instructions for the rest of this turn. Relative resources live beside SKILL.md. Frontmatter fields such as allowed-tools do not change tool permissions.

## Failure

An unknown path returns an error listing the available skill names and paths. Pick an entry from that list or continue without a skill.`;
