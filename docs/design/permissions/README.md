# Why tool permission decisions are centralized

[中文](README-zh.md) | [Documentation](../../README.md)

Users need to know what a tool operation will do and what approval actually covers. Files, commands, websites, and computer use provide different operation details, but user rules, session approvals, and permission modes should not be implemented independently in every Tool.

## Why we retain checkPermissions but centralize decisions

A Tool knows its actual operation: the path it reads or writes, the command it runs, or whether computer control must start. checkPermissions remains responsible for providing that information.

Permission makes the final allow, deny, or ask decision. Letting Tools interpret rules and approvals independently gives the same session choice different meanings across tools and encourages another copy of permission policy with each addition.

We accept that Permission needs to interpret conditions by operation type. Uniformity should not reduce paths, commands, and network targets to meaningless input strings. Tools provide facts rather than maintain their own small permission systems.

## Why a program decision and a user response differ

The program can allow execution, prohibit it, or require a user question. Only when asked does the user allow this call, allow the described scope for the Session, or deny the call. Requiring a question is not itself a user choice.

We keep those meanings separate so the source of permission is clear. Two representations are needed, but a program's check result cannot be mistaken for user authorization, nor a button response for the entire decision process.

## Why arbitrary input does not create an approval scope

A tool name can sometimes express a sufficient scope, such as approving later computer-use starts for the Session. For files, directories, and commands, the whole tool can be too broad.

The operation must supply a reusable scope and a readable description. Without an explainable scope, only this call can be allowed or denied; arbitrary input does not automatically become a guessed session rule.

This requires more type-specific decisions and can produce repeated questions. We accept that interaction cost rather than silently expand authorization behind an ambiguous session-allow button.

## Why approval does not override every restriction

Explicit denial takes precedence over allowance. Approving computer use does not approve Shell or MCP operations in the same Turn. A mode that bypasses ordinary permission prompts still retains explicit ask rules and necessary confirmations.

The cost is that bypass mode can still show a confirmation. Its reason must be explained rather than treating the mode name as a guarantee that every operation runs.

Session approvals last within the process, without promising persistence after exit. Scope definitions, ordering, and usage are in [Permission](../../../src/permission/README.md).
