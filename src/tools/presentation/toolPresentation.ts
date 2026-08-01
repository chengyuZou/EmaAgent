// 汇总工具执行后可以跨后端和前端传递的可信展示数据。
import type { CommandPresentation } from './commandPresentation.js';
import type { FileChangePresentation } from './fileChangePresentation.js';
import type { FileReadPresentation } from './fileReadPresentation.js';
import type { PdfReadPresentation } from './pdfReadPresentation.js';
import type { SearchPresentation } from './searchPresentation.js';
import type { BackgroundProcessPresentation } from './backgroundProcessPresentation.js';

export type ToolPresentation =
  | FileChangePresentation
  | FileReadPresentation
  | PdfReadPresentation
  | CommandPresentation
  | BackgroundProcessPresentation
  | SearchPresentation;

/** 在持久化或跨进程 JSON 回到业务层时校验展示协议。 */
export function isToolPresentation(value: unknown): value is ToolPresentation {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;

  switch (value.kind) {
    case 'file_change':
      return (value.operation === 'create' || value.operation === 'update')
        && typeof value.filePath === 'string'
        && typeof value.unifiedDiff === 'string'
        && typeof value.additions === 'number'
        && typeof value.deletions === 'number'
        && typeof value.truncated === 'boolean'
        && isOptionalString(value.omittedReason);
    case 'file_read':
      return typeof value.filePath === 'string'
        && (value.status === 'content' || value.status === 'unchanged')
        && typeof value.startLine === 'number'
        && typeof value.endLine === 'number'
        && isOptionalNumber(value.totalLines)
        && typeof value.partial === 'boolean'
        && typeof value.truncated === 'boolean';
    case 'pdf_read':
      return typeof value.filePath === 'string'
        && typeof value.startPage === 'number'
        && typeof value.endPage === 'number'
        && typeof value.totalPages === 'number'
        && typeof value.hasMore === 'boolean'
        && typeof value.incompletePages === 'number';
    case 'command':
      return typeof value.command === 'string'
        && typeof value.workingDirectory === 'string'
        && typeof value.exitCode === 'number'
        && typeof value.timedOut === 'boolean'
        && typeof value.aborted === 'boolean'
        && typeof value.truncated === 'boolean';
    case 'search':
      return (value.operation === 'content_search' || value.operation === 'file_search')
        && typeof value.pattern === 'string'
        && typeof value.searchPath === 'string'
        && typeof value.resultCount === 'number'
        && typeof value.truncated === 'boolean'
        && isSearchLimitReason(value.limitReason);
    case 'background_process':
      return typeof value.backgroundProcessId === 'string'
        && typeof value.command === 'string'
        && typeof value.workingDirectory === 'string'
        && isBackgroundProcessStatus(value.status);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function isSearchLimitReason(value: unknown): boolean {
  return value === undefined || value === 'results' || value === 'bytes' || value === 'timeout';
}

function isBackgroundProcessStatus(value: unknown): boolean {
  return value === 'queued'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'timedOut'
    || value === 'stopped'
    || value === 'interrupted';
}
