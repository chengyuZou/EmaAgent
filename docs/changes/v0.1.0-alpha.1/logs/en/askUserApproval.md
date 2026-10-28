# AskUser approval before questions

[中文](../zh/askUserApproval.md)

## Status and scope

Diagnosed on 2026-10-20. The reported symptom was a permission card with raw AskUser arguments before the actual question choices. The source reproduction did not require a UI, a model call or any saved permission rules. No business code or real user data was changed during diagnosis. The user subsequently changed AskUser's own permission check to return `allow`; the source review did not rerun tests. On the same date, the user confirmed that AskUser no longer asks for Permission before presenting questions. The reported extra-approval issue is accepted as resolved for that user-tested build. Its exact identifier and Dev/release type were not specified; this is not acceptance of every AskUser interaction or all release packages.

The separate custom-answer input report has a readable screenshot showing an extra sharp-cornered rectangle around the rounded text field, distinct from the outer selected-option card. That visual issue is outside this approval fix; no input or permission-menu styling was changed as part of it.

## Reproduction before the source adjustment

A local stdin harness ran with `node --experimental-transform-types --input-type=module -`. It used the real [AskUserTool](../../../../../src/builtin-tools/tools/AskUserTool/AskUserTool.ts), [ToolPool](../../../../../src/tools/assembly/toolPool.ts) and [ToolCallExecution](../../../../../src/tools/execution/toolCallExecution.ts), with empty permission-rule buckets and default mode. The fixture provided one question, two choices and immediate in-memory responses for both interaction callbacks. It recorded which callback ran first.

The assertion required only the question callback. Two consecutive runs failed in less than one second each:

```text
expected calls: ["question"]
actual calls:   ["permission", "question"]
AssertionError: AskUser must reach the question channel without an extra approval.
exit code: 1
```

The control harness redirected `@ema-agent/tools` and `@ema-agent/permission` imports to their current source entry points, resolved relative `.js` source imports to `.ts`, and repeated the real execution path. This avoided treating a stale package build as the cause. The import redirects existed only in that Node process; no files or runtime settings were changed.

## Controls

The hypotheses were an AskUser-specific permission decision, a central default-mode rule, or frontend confusion between question and approval events. Each control changed one input from the stated comparison case:

| Case | Callback order / result |
| --- | --- |
| Real AskUser, default mode, no rules | Permission, then question |
| Only mode changed to `bypassPermissions` | Permission, then question |
| Only a user-level whole-tool allow rule added | Permission, then question |
| Only the test copy's `checkPermissions` changed to return `allow` | Question only |
| Only the test copy's `requiresUserInteraction` changed to false | Permission, then question |
| Self-check allow, with an explicit whole-tool deny rule | No interaction callback; `permission/denied` |
| Self-check allow, with an explicit whole-tool ask rule | Permission, then question |

All seven control assertions passed. A test copy is an in-memory object retaining the real tool's schema, validation and execution, with only the named field replaced. This is not a shipped fix or a complete interaction regression test.

## Confirmed cause and event flow

At diagnosis, AskUser's `checkPermissions` unconditionally returned `behavior: 'ask'`. Its nearby comment conflated waiting for a user's answer with requiring permission to execute the tool.

[hasPermissionsToUseTool](../../../../../src/permission/hasPermissionsToUseTool.ts) processes the tool's explicit ask before bypass mode and ordinary user/project allow rules. [ToolCallExecution](../../../../../src/tools/execution/toolCallExecution.ts) therefore called `askPermission` before reaching `execute`, where AskUser calls the separate `askUser` channel. Exact-input Session approvals are a separate earlier rule path, so the tool's ask is not an absolute prohibition on all rule-based approval.

[prepareTurnTools](../../../../../src/turn/tools/turnTools.ts) publishes `permission_required` for the first channel and `ask_user_required` for the second. The frontend [session activity Store](../../../../../apps/desktop/src/stores/sessionActivity.ts) retains these as distinct interaction kinds, and [PendingInteractionView](../../../../../apps/desktop/src/chat/interactions/PendingInteractionView.tsx) selects the corresponding view. The reported default sequence is produced before rendering, not by relabeling a question as a permission card.

`requiresUserInteraction` is consumed by the streaming executor's waiting-user check. It is not the switch that asks for permission and should not be removed to address this symptom.

## Source adjustment and remaining verification

The user changed AskUser's own permission check to return `allow`. The source review confirmed that narrow adjustment; the real question channel, waiting-user marker, cancellation, answer mapping and central explicit ask/deny rules remain in place. It is intended to remove the extra approval in the normal case without changing other tools or ignoring an explicit user policy. Exempting AskUser from explicit policies is not part of this adjustment.

At the user's request, the source review did not run tests. The earlier in-memory allow control supports the diagnosis, but is not a regression result for the edited file. The subsequent user confirmation establishes that the unwanted approval no longer precedes questions in the tested application. Explicit-rule behavior, answer/cancel handling and multiple question calls are not established by that confirmation and still need verification. Native foreground/background notification routing and custom-answer input styling remain separate work.
