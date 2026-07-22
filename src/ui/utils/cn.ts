import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// ── cn() — class name composer ──────────────────────────────────────────────
//
// Combines clsx (conditional class composition) with tailwind-merge
// (resolves conflicting Tailwind/Wind utilities by keeping only the last).
//
// Use everywhere instead of template strings or array joins.
//
// Examples:
//   cn('p-4', 'bg-primary-500', condition && 'hidden')
//     → 'p-4 bg-primary-500 hidden'  (or without 'hidden' if !condition)
//
//   cn('p-2 bg-red-500', overrideClasses)
//   // with overrideClasses = 'p-4 bg-blue-500':
//     → 'p-4 bg-blue-500'  (later wins for conflicting properties)
//
//   cn({ active: isActive, disabled: !isReady })
//     → 'active'  (if isActive=true, isReady=true)

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
