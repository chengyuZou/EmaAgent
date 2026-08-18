// FileReadTool 的 Notebook 分支: 解析 .ipynb 为 cells(含输出), 大输出截断,
// 投影为模型可见文本 + 输出图片块。
import fs from 'node:fs';
import path from 'node:path';
import type { ToolResultContentPart } from '@ema-agent/llm';
import { NOTEBOOK_SIZE_LIMIT } from './limits.js';

/** .ipynb 扩展名判定(大小写不敏感)。 */
export function isNotebookPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.ipynb';
}

export type NotebookCellType = 'code' | 'markdown';
export type NotebookMediaType = 'image/png' | 'image/jpeg';

export interface NotebookCellSource {
  cellType: NotebookCellType;
  source: string;
  executionCount?: number;
  language?: string;
  cellId: string;
  outputs?: NotebookCellSourceOutput[];
}

export interface NotebookCellSourceOutput {
  outputType: 'stream' | 'execute_result' | 'display_data' | 'error';
  text?: string;
  image?: { imageData: string; mediaType: NotebookMediaType };
}

export interface FileReadNotebookResult {
  type: 'notebook_content';
  filePath: string;
  totalCells: number;
  cells: NotebookCellSource[];
}

interface RawCellOutput {
  output_type?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface RawCell {
  id?: string;
  cell_type?: string;
  source?: string | string[];
  execution_count?: number | null;
  outputs?: RawCellOutput[];
}

interface RawNotebook {
  cells?: RawCell[];
  metadata?: { language_info?: { name?: string } };
}

/** 输出过大判定阈值: 单个 cell 输出累计超 10K 字符则整体替换为提示。 */
const LARGE_OUTPUT_THRESHOLD = 10_000;

function isLargeOutputs(outputs: (NotebookCellSourceOutput | undefined)[]): boolean {
  let size = 0;
  for (const output of outputs) {
    if (!output) continue;
    size += (output.text?.length ?? 0) + (output.image?.imageData.length ?? 0);
    if (size > LARGE_OUTPUT_THRESHOLD) return true;
  }
  return false;
}

/** 输出文本: 数组拼平; 单块超阈值就地截断, 防止单条输出撑爆上下文。 */
function processOutputText(text: string | string[] | undefined): string {
  if (!text) return '';
  const raw = Array.isArray(text) ? text.join('') : text;
  return raw.length > LARGE_OUTPUT_THRESHOLD
    ? `${raw.slice(0, LARGE_OUTPUT_THRESHOLD)}\n[Output truncated: ${raw.length - LARGE_OUTPUT_THRESHOLD} more chars]`
    : raw;
}

function extractImage(
  data: Record<string, unknown> | undefined,
): { imageData: string; mediaType: NotebookMediaType } | undefined {
  if (!data) return undefined;
  if (typeof data['image/png'] === 'string') {
    return { imageData: data['image/png'].replace(/\s/g, ''), mediaType: 'image/png' };
  }
  if (typeof data['image/jpeg'] === 'string') {
    return { imageData: data['image/jpeg'].replace(/\s/g, ''), mediaType: 'image/jpeg' };
  }
  return undefined;
}

function processOutput(output: RawCellOutput): NotebookCellSourceOutput | undefined {
  switch (output.output_type) {
    case 'stream':
      return { outputType: 'stream', text: processOutputText(output.text) };
    case 'execute_result':
    case 'display_data':
      return {
        outputType: output.output_type,
        text: processOutputText(output.data?.['text/plain'] as string | string[] | undefined),
        image: extractImage(output.data),
      };
    case 'error':
      return {
        outputType: 'error',
        text: processOutputText(
          `${output.ename}: ${output.evalue}\n${(output.traceback ?? []).join('\n')}`,
        ),
      };
    default:
      return undefined;
  }
}

function processCell(cell: RawCell, index: number, language: string): NotebookCellSource {
  const cellType: NotebookCellType = cell.cell_type === 'markdown' ? 'markdown' : 'code';
  const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
  const result: NotebookCellSource = {
    cellType,
    source,
    cellId: cell.id ?? `cell-${index}`,
    ...(cellType === 'code' && cell.execution_count ? { executionCount: cell.execution_count } : {}),
    ...(cellType === 'code' ? { language } : {}),
  };
  if (cellType === 'code' && cell.outputs?.length) {
    const outputs = cell.outputs
      .map(processOutput)
      .filter((output): output is NotebookCellSourceOutput => output !== undefined);
    if (isLargeOutputs(outputs)) {
      result.outputs = [{
        outputType: 'stream',
        text: 'Outputs are too large to include. Use Bash with: cat <notebook_path> | jq \'.cells[index].outputs\'',
      }];
    } else if (outputs.length > 0) {
      result.outputs = outputs;
    }
  }
  return result;
}

/** 读取并解析 .ipynb 为 cells。体积超限 / JSON 损坏 / 无 cells 抛可读错误。 */
export async function readNotebookFile(options: {
  fullPath: string;
  displayPath: string;
  sizeBytes: number;
  signal: AbortSignal;
}): Promise<FileReadNotebookResult> {
  if (options.sizeBytes > NOTEBOOK_SIZE_LIMIT) {
    throw new Error(
      `Notebook is too large (${(options.sizeBytes / 1024 / 1024).toFixed(1)} MiB > ${NOTEBOOK_SIZE_LIMIT / 1024 / 1024} MiB).`,
    );
  }
  const buffer = await fs.promises.readFile(options.fullPath, { signal: options.signal });
  let notebook: RawNotebook;
  try {
    notebook = JSON.parse(buffer.toString('utf-8')) as RawNotebook;
  } catch {
    throw new Error(`Notebook is not valid JSON: ${options.displayPath}`);
  }
  if (!Array.isArray(notebook.cells)) {
    throw new Error(`Notebook has no cells array: ${options.displayPath}`);
  }
  const language = notebook.metadata?.language_info?.name ?? 'python';
  const cells = notebook.cells.map((cell, index) => processCell(cell, index, language));
  return {
    type: 'notebook_content',
    filePath: options.displayPath,
    totalCells: cells.length,
    cells,
  };
}

/** 投影: cells → 模型可见文本块 + 输出图片块(相邻文本合并)。 */
export function renderNotebookCells(cells: NotebookCellSource[]): ToolResultContentPart[] {
  const parts: ToolResultContentPart[] = [];
  for (const cell of cells) {
    const metadata: string[] = [];
    if (cell.cellType !== 'code') metadata.push(`<cell_type>${cell.cellType}</cell_type>`);
    if (cell.cellType === 'code' && cell.language !== 'python') {
      metadata.push(`<language>${cell.language}</language>`);
    }
    pushText(parts, `<cell id="${cell.cellId}">${metadata.join('')}${cell.source}</cell id="${cell.cellId}">`);
    for (const output of cell.outputs ?? []) {
      if (output.text) pushText(parts, `\n${output.text}`);
      if (output.image) {
        parts.push({ type: 'image_data', data: output.image.imageData, mimeType: output.image.mediaType });
      }
    }
  }
  return parts;
}

function pushText(parts: ToolResultContentPart[], text: string): void {
  const prev = parts[parts.length - 1];
  if (prev && prev.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: `${prev.text}\n${text}` };
  } else {
    parts.push({ type: 'text', text });
  }
}
