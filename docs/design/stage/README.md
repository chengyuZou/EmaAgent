# Why static illustrations participate in character expression

[中文](README-zh.md) | [Documentation](../../README.md)

We want a character to do more than sit beside the chat as a single image. Expressions can respond as the dialogue changes, creating a scene similar to a Galgame's character illustrations accompanying dialogue.

## Why illustrations have emotion mappings

A static character shown with one image can express happiness, uncertainty, or sadness only through text. Even a user who has prepared different expressions must switch them manually.

We group illustrations by emotion and connect the dialogue's emotion to the corresponding pictures. A set of expression illustrations can provide this presentation without first building a Live2D model.

We accept that static assets can switch only among supplied expressions and cannot create missing artwork. Their value is connecting dialogue with the character's image, not guaranteeing that every emotional judgment or image change is appropriate.

## Why character resources determine the mapping

Characters have different amounts and styles of artwork, and filenames do not necessarily describe the appropriate emotion. Users configure the emotion associated with each picture, and the character receives the presentation names configured for its current resources.

This avoids requiring every character to follow one filename convention or supply an identical set of expressions. The cost is organizing and configuring imported images. Configuration quality affects the result; assigning a shared emotion name cannot make unsuitable artwork appropriate.

## Presentation limits we accept

Expression changes help create a scene but do not replace the persona or the reply itself. The model can choose an unsuitable emotion, and available artwork may not express a particular exchange. We accept adjustment through persona and resource configuration rather than treat mappings as proof that the character's personality works correctly.

Ownership of the current dialogue and Stage presentation is discussed with [speech design](../speech/README.md). Resource configuration and tag usage are covered in [Characters](../../../src/characters/README.md) and the [Stage module](../../../src/stage/README.md).
