// 将前端草稿中的图片和长粘贴落盘，按原顺序交给 Turn 输入。
import type { TurnInputPart } from '@ema-agent/turn';
import { sessionsApi } from '../../api/sessions.js';
import type { ChatDraftPart } from './InputReferences.js';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('剪贴板图片读取失败'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function finalizeDraft(sessionId: string, parts: readonly ChatDraftPart[]): Promise<TurnInputPart[]> {
  const output: TurnInputPart[] = [];
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'skill_reference') {
      output.push(part);
      continue;
    }
    if (part.type === 'file') {
      output.push({
        type: 'attachment',
        block: { type: 'file_reference', path: part.path },
      });
      continue;
    }
    if (part.type === 'pasted_text') {
      const saved = await sessionsApi.createPastedText(sessionId, part.content);
      output.push({
        type: 'attachment',
        block: {
          type: 'pasted_text_reference',
          path: saved.path,
          preview: saved.preview,
        },
      });
      continue;
    }
    const name = part.name ?? part.sourcePath?.split(/[\\/]/).pop();
    const saved = part.file
      ? await sessionsApi.uploadImage(sessionId, {
          dataBase64: await fileToBase64(part.file),
          ...(name ? { name } : {}),
        })
      : await sessionsApi.uploadImage(sessionId, {
          sourcePath: part.sourcePath!,
          ...(name ? { name } : {}),
        });
    output.push({
      type: 'attachment',
      block: {
        type: 'image_reference',
        path: saved.path,
        ...(name ? { name } : {}),
      },
    });
  }
  return output;
}
