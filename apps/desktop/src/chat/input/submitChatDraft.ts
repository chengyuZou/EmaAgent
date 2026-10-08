// 将一份草稿提交到已经存在的 Session; 新对话必须先取得真实 Session ID.
import type { TurnInputPart } from '@ema-agent/turn';
import { sessionsApi } from '../../api/sessions.js';
import { SessionRequestError, sessionWebSocket } from '../../api/sessionWebSocket.js';
import { restoreFailedDraft, useChatDraftStore, type ChatDraft } from '../../stores/chatDraft.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useSessionStore } from '../../stores/session.js';
import { ensureSessionSubscription } from '../session/sessionSubscriptions.js';

export async function submitChatDraft(
  sessionId: string,
  submitted: ChatDraft,
  objective?: string,
): Promise<void> {
  let requestStarted = false;
  try {
    // 模型切换写入 Session 后, Turn 才能从同一份已保存设置读取模型.
    await useSessionStore.getState().waitForModelSettings(sessionId);
    const session = useSessionStore.getState().sessions.byId.get(sessionId);
    if (!session?.providerId || !session.modelId) {
      throw new Error('模型设置尚未保存, 请重新选择后发送');
    }

    // 权限选择必须排在先前的 Session 设置之后保存, Turn 才读取到本次提交的权限.
    await useSessionStore.getState().setPermissionMode(sessionId, submitted.permissionMode);
    ensureSessionSubscription(sessionId);
    const input = await finalizeDraft(sessionId, submitted);
    const payload = {
      input,
      sessionMode: submitted.sessionMode,
      narrativePolicy: submitted.narrativePolicy,
      ...(objective !== undefined ? { objective } : {}),
    };

    // 附件上传期间活动状态可能改变, 所以发送前才决定直接提交还是排队.
    const running = useSessionActivityStore.getState().bySession.get(sessionId)?.running;
    if (running?.kind === 'compact') {
      throw new Error('当前会话正在压缩, 请稍后发送');
    }
    requestStarted = true;
    if (running?.kind === 'turn') {
      await sessionWebSocket.queueUserMessage(sessionId, payload);
    } else {
      await sessionWebSocket.sendUserMessage(sessionId, payload);
    }
  } catch (error) {
    // 断线时 Server 可能已保存 UserMessage 或排队项, 不能把旧输入放回草稿诱导重复发送.
    const definitelyNotStored = !requestStarted
      || (error instanceof SessionRequestError
        && (
          error.code === 'empty_input'
          || error.code === 'session_idle'
          || error.code === 'session_busy'
          || error.code === 'session_not_found'
          || error.code === 'goal_already_exists'
          || error.code === 'goal_plan_conflict'
          || error.code === 'goal_objective_empty'
        ));
    if (definitelyNotStored) {
      const drafts = useChatDraftStore.getState();
      drafts.setForSession(sessionId, restoreFailedDraft(submitted, drafts.bySession.get(sessionId)));
    }
    throw error;
  }
}

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

async function finalizeDraft(sessionId: string, draft: ChatDraft): Promise<TurnInputPart[]> {
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
