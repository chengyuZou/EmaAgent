// ── Live2D expression tools for LLM ──────────────────────────────────────────
//
// Three tools exposed to the LLM agent so it can control the character's
// expressions in real time:
//
//   expression_set     — Activate / deactivate an expression with optional
//                        auto-reset duration
//   expression_get     — Query current expression state (single or all)
//   expression_toggle  — Flip an expression on/off
//
// These mirror AIRI's packages/stage-ui-live2d/tools/expression-tools.ts.
// The tool definitions below use a generic `tool()` wrapper — your agent
// framework (LangChain / Vercel AI SDK / custom) will need to adapt the
// calling convention. The execute functions are pure and can be wrapped in
// any format.
//
// Each execute function returns a JSON-stringified ExpressionToolResult so
// the LLM can parse the outcome.

import type { ExpressionToolResult } from '../stores/expression-store.js';
import { useExpressionStore } from '../stores/expression-store.js';
import { useLive2DStore } from '../stores/live2d-store.js';

// ── Parameters shapes ───────────────────────────────────────────────────────

export interface ExpressionSetParams {
  /** Expression name or Live2D parameter ID (e.g. "Smile", "ParamMouthForm"). */
  name: string;
  /** true/false to activate/deactivate, or 0.0-1.0 for numeric values. */
  value: boolean | number;
  /** Seconds until auto-reset. Omit for permanent. */
  duration?: number;
}

export interface ExpressionGetParams {
  /** Expression name or parameter ID. Omit to list all. */
  name?: string;
}

export interface ExpressionToggleParams {
  /** Expression name or parameter ID to toggle. */
  name: string;
  /** Seconds until auto-reset when toggling ON. Omit for permanent. */
  duration?: number;
}

// ── Tool implementations ────────────────────────────────────────────────────

function ensureModelLoaded(): ExpressionToolResult | null {
  const store = useExpressionStore.getState();
  if (!store.modelId || store.expressions.size === 0) {
    return { success: false, error: 'No Live2D model is currently loaded.' };
  }
  return null;
}

function serialize(result: ExpressionToolResult): string {
  return JSON.stringify(result);
}

/**
 * Activate or deactivate a Live2D expression.
 *
 * When `value` is a boolean:
 *   - true  → activate (set to exp3 targetValue)
 *   - false → deactivate (restore to modelDefault)
 *
 * When `value` is a number (0.0-1.0):
 *   - Direct numeric value (useful for intensity control)
 *
 * If `duration` is provided, the expression auto-resets after that many
 * seconds. Omit for a permanent change.
 *
 * Also syncs the `activeExpressions[]` array in useLive2DStore so the
 * Live2DStage's subscription picks up the change.
 */
export async function expressionSet(
  { name, value, duration }: ExpressionSetParams,
): Promise<string> {
  const err = ensureModelLoaded();
  if (err) return serialize(err);

  const exprStore = useExpressionStore.getState();
  const live2dStore = useLive2DStore.getState();

  const numericValue = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  const result = exprStore.set(name, numericValue, duration);

  // Keep live2d-store's activeExpressions in sync
  if (typeof value === 'boolean') {
    if (value) {
      live2dStore.addExpression(name);
    } else {
      live2dStore.removeExpression(name);
    }
  } else if (numericValue !== 0) {
    // Non-zero numeric: treat as activation
    live2dStore.addExpression(name);
  } else {
    live2dStore.removeExpression(name);
  }

  return serialize(result);
}

/**
 * Query the current state of one or all expressions.
 *
 * - With `name`: returns the state of that expression/parameter
 * - Without `name`: returns all expressions with current values
 */
export async function expressionGet(
  { name }: ExpressionGetParams,
): Promise<string> {
  const err = ensureModelLoaded();
  if (err) return serialize(err);

  const store = useExpressionStore.getState();
  const result = store.get(name);
  return serialize(result);
}

/**
 * Toggle an expression between active and inactive states.
 *
 * When toggling ON, the `duration` parameter controls auto-reset (same as
 * `expression_set`). Toggling OFF always restores immediately.
 *
 * Also updates `activeExpressions[]` in useLive2DStore.
 */
export async function expressionToggle(
  { name, duration }: ExpressionToggleParams,
): Promise<string> {
  const err = ensureModelLoaded();
  if (err) return serialize(err);

  const exprStore = useExpressionStore.getState();
  const live2dStore = useLive2DStore.getState();

  const result = exprStore.toggle(name, duration);

  // Sync live2d-store: if the toggle result indicates active, add it
  if (result.success && result.state) {
    const states = Array.isArray(result.state) ? result.state : [result.state];
    const isNowActive = states.every((s) => s.active);
    if (isNowActive) {
      live2dStore.addExpression(name);
    } else {
      live2dStore.removeExpression(name);
    }
  }

  return serialize(result);
}

// ── Tool descriptor (for Vercel AI SDK / LangChain / custom) ────────────────

/**
 * Tool descriptors suitable for passing directly to Vercel AI SDK's
 * `tool()` helper or a similar function-calling framework.
 *
 * Usage with Vercel AI SDK:
 * ```ts
 * import { tool } from 'ai';
 * import { z } from 'zod';
 * import { live2dTools } from '@ema-agent/live2d-react/tools';
 *
 * const tools = {
 *   ...live2dTools,
 *   // ... other tools
 * };
 * ```
 *
 * If your framework uses a different format, use the raw execute functions
 * above directly.
 */
export const live2dExpressionToolDefs = {
  expression_set: {
    description:
      'Set a Live2D expression or parameter value. ' +
      'Use true/false to toggle, or a number (0.0-1.0) for intensity. ' +
      'Optionally provide a duration in seconds for auto-reset. ' +
      'Examples: expression_set("Smile", true), expression_set("Blush", 0.7, 3)',
    parameters: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Expression name or Live2D parameter ID (e.g. "Smile", "ParamMouthForm")',
        },
        value: {
          description: 'true/false for toggle, or 0.0-1.0 for numeric control',
        },
        duration: {
          type: 'number',
          description: 'Seconds until auto-reset. Omit for permanent change.',
        },
      },
      required: ['name', 'value'],
    },
    execute: async (args: ExpressionSetParams) => expressionSet(args),
  },

  expression_get: {
    description:
      'Get the current state of a Live2D expression or parameter. ' +
      'Omit the name to list all available expressions with their values.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Expression name or parameter ID. Omit to list all.',
        },
      },
    },
    execute: async (args: ExpressionGetParams) => expressionGet(args),
  },

  expression_toggle: {
    description:
      'Toggle a Live2D expression (flip between default and active state). ' +
      'When toggling ON, optional duration for auto-reset.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Expression name or parameter ID to toggle.',
        },
        duration: {
          type: 'number',
          description: 'Seconds until auto-reset when toggling ON. Omit for permanent.',
        },
      },
      required: ['name'],
    },
    execute: async (args: ExpressionToggleParams) => expressionToggle(args),
  },
};
