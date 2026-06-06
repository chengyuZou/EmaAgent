/** Default priority for hook handlers. Lower numbers run first. */
export const PRIORITY_DEFAULT = 100;

/** Well-known priority slots — use these instead of magic numbers. */
export const PRIORITY = {
  /** Runs before most handlers — system prompt construction, routing context */
  FIRST: 10,
  /** Runs early — skills, memory recall, contextual augmentation */
  EARLY: 20,
  /** Default slot */
  DEFAULT: 100,
  /** Runs after most handlers — telemetry, audit */
  LATE: 200,
} as const;
