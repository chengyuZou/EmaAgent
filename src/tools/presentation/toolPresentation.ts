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
