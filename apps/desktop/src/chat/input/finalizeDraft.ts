// 发送前将图片与长粘贴落盘, 再按输入区可见的顺序生成 Turn 输入.
import type { TurnInputPart } from '@ema-agent/turn';
import { sessionsApi } from '../../api/sessions.js';
import type { ChatDraft } from '../../stores/chatDraft.js';

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

export async function finalizeDraft(sessionId: string, draft: ChatDraft): Promise<TurnInputPart[]> {
  const output: TurnInputPart[] = [];
  // Textarea 与胶囊已是两份状态. 后端按数组顺序保存和展示, 所以文字固定在前,
  // 其余项只按胶囊加入顺序处理; 不再猜用户改字后隐藏引用该落在哪个 offset.
  if (draft.text.trim()) output.push({ type: 'text', text: draft.text });
  for (const part of draft.references) {
    if (part.type === 'skill_reference') {
      output.push({ type: 'skill_reference', name: part.name, path: part.path });
      continue;
    }
    if (part.type === 'file_reference') {
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
          sourcePath: part.sourcePath,
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
