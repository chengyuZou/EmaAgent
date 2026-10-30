# Why TurnReminder marks character switches

[中文](README-zh.md) | [Documentation](../../README.md)

A Session can use different characters over time. We want to retain the discussion and user decisions while preventing the current character from claiming another character's name, profession, or personal experiences.

## Why we do not rewrite each old message

Earlier Assistant utterances remain assistant messages in model history. Changing the current persona alone does not ensure the model distinguishes who made those earlier statements.

We considered adding character explanations to individual old messages and tried longer explanations inside old assistant content. That changes the original history, requires checking identity message by message, and can make the model treat the explanations as content it should continue generating.

We chose to preserve saved messages and mark where the speaking character changes. Switching characters need not repeatedly rewrite all history, and the discussion and tool-confirmed facts remain usable.

## Why the reminder follows each Session's Turn

At Turn start, the previous character in that Session determines whether a switch occurred. Only an actual change adds a switch explanation to the existing TurnReminder. A global character-button change does not insert one in advance.

The reminder identifies adjacent stretches of character dialogue. Switching from A to B and back to A does not make B's intervening statements belong to A. Continuing with the same character needs no repeated switch declaration.

The reminder is saved before that Turn's user input. History replay uses the recorded boundaries instead of recomputing past identities from the currently selected character. The System Prompt retains brief current-identity guidance; Reminder supplies the switching boundaries.

## Why we minimize changes to existing context

Switching characters already changes persona content in the request. We avoid adding unnecessary rewrites to old messages, preserving unchanged content and reducing additional disruption to request-prefix caching.

This does not guarantee a cache hit across character switches. System Prompt changes, model choice, and provider behavior can affect the result. We minimize unnecessary history changes rather than promise a fixed cache rate from one successful observation.

## Limits we accept

Reminder gives the model an identity boundary, not an execution mechanism that forces isolation of every first-person statement. Long histories, summaries, and persona quality still affect the result. We accept the need to observe character behavior and do not treat avoiding identity confusion as proof of natural personality.

User requirements, confirmed decisions, and tool facts should remain available. Another character's private promises and experiences should not automatically become the current character's own. Saving and replay contracts are in [Turn](../../../src/turn/README.md) and [Context](../../../src/context/README.md).
