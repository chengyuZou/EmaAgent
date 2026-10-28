import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { buildTool, contextFail, contextOk, type ToolUseContext } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { imageMediaTypeFor, readImageFile, type FileReadImageResult } from '../FileReadTool/imageReader.js';
import { imageResultNotice } from '../FileReadTool/prompt.js';
import { CAPTURE_DESCRIPTION } from './prompt.js';

const inputSchema = z.object({}).strict();

export const CaptureTool = buildTool<
  z.infer<typeof inputSchema>,
  FileReadImageResult,
  { readonly captureScreen: NonNullable<ToolUseContext['captureScreen']> }
>({
  id: BuiltinTools.Capture.id,
  name: BuiltinTools.Capture.name,
  description: CAPTURE_DESCRIPTION,
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  getToolUseSummary: () => '截取当前屏幕',
  validateContext(context) {
    if (!context.captureScreen) return contextFail('当前宿主未提供屏幕捕获.');
    return contextOk({ captureScreen: context.captureScreen });
  },
  
  async checkPermissions() {
    return { kind: 'tool', defaultDecision: 'ask', message: '允许截取当前屏幕并交给模型读取吗?', sessionApproval: 'tool' };
  },

  async execute(_input, context, invocation) {
    const filePath = await context.captureScreen(invocation.sessionId, invocation.turnId, invocation.signal);
    const mediaType = imageMediaTypeFor(filePath)!;
    const file = await stat(filePath);
    return readImageFile({
      fullPath: filePath,
      displayPath: filePath,
      mediaType,
      sizeBytes: file.size,
      signal: invocation.signal,
    });
  },

  mapResultToModelContent(output) {
    return [
      { type: 'text', text: imageResultNotice(output.filePath, output.mediaType, output.originalBytes) },
      { type: 'image_data', data: output.base64, mimeType: output.mediaType },
    ];
  },
});
