/** Well-known priority slots — use these instead of magic numbers. Lower numbers run first. */
export const PRIORITY = {
  /** System-level: character card injection, system prompt base construction. */
  FIRST:   10,
  /** Recall phase: memory recall, narrative context, contextual augmentation. */
  EARLY:   20,
  /** Augmentation phase: skill prompt injection, mode-specific additions. */
  NORMAL:  50,
  /** Default slot for general-purpose handlers. */
  DEFAULT: 100,
  /** Post-processing: audit, telemetry, cleanup. */
  LATE:    200,
} as const;
