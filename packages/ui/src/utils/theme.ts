import { VAR_HUE, EMA_PRIMARY_HUE } from '../uno-preset-chromatic.js';
import { VAR_RADIUS } from '../../uno.config.js';

/** Default radius multiplier — matches the :root preflight. */
const DEFAULT_RADIUS = 1;

// ── Runtime theme hue control ─────────────────────────────────────────────────
//
// The chromatic preset injects --chromatic-hue into :root at build time.
// These helpers let callers update it at runtime (e.g. from a settings slider).
//
// Persistence is the caller's responsibility — store the value in profile.db
// and call setThemeHue() on app startup to restore it.

/**
 * Set the global primary hue (0–360). Updates both `primary` and `violet`
 * palettes immediately — no page reload needed.
 */
export function setThemeHue(hue: number): void {
  const clamped = ((hue % 360) + 360) % 360;
  document.documentElement.style.setProperty(VAR_HUE, String(clamped));
}

/**
 * Read the current primary hue from the document root.
 * Falls back to EMA_PRIMARY_HUE if the variable is not set.
 */
export function getThemeHue(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(VAR_HUE)
    .trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : EMA_PRIMARY_HUE;
}

/**
 * Reset primary hue back to Ema's default pink (350°).
 */
export function resetThemeHue(): void {
  document.documentElement.style.removeProperty(VAR_HUE);
}

// ── Runtime shape / radius control ───────────────────────────────────────────

/**
 * Set the global border-radius multiplier.
 * 0 = sharp corners, 1 = default, 1.5 = softer, 2 = very round.
 * pill/full radii are unaffected — they stay 9999px / 50%.
 */
export function setThemeRadius(multiplier: number): void {
  const clamped = Math.max(0, Math.min(3, multiplier));
  document.documentElement.style.setProperty(VAR_RADIUS, String(clamped));
}

/**
 * Read the current radius multiplier from the document root.
 * Falls back to 1 (default) if the variable is not set.
 */
export function getThemeRadius(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(VAR_RADIUS)
    .trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_RADIUS;
}

/**
 * Reset radius back to the default (1×).
 */
export function resetThemeRadius(): void {
  document.documentElement.style.removeProperty(VAR_RADIUS);
}
