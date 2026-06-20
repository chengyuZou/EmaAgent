// ── AgentKind ─────────────────────────────────────────────────────────────────
//
// Determines how a sub-agent's initial context is constructed.
// Lives in contracts (not in @ema-agent/tool) so event types in events.ts can
// reference it without creating a circular dependency.
//
// 'coordinator-worker' (expanded tool permissions) is deferred to V2.

export type AgentKind = 'subagent' | 'fork';
