import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// ── cn() — class name composer ──────────────────────────────────────────────
//
// clsx(条件类名组合) + tailwind-merge(同类工具类后者覆盖前者),
// 全项目统一用它替代模板字符串拼接。
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
