import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并条件类名, 按 tailwind-merge 已知的工具类规则处理冲突. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
