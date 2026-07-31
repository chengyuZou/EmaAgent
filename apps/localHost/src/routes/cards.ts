// 角色卡 HTTP 装配入口:只拼装 cards/ 子路由,协议与业务各归其文件。
// Mounted at `/api/cards`:
//   cardCrud.ts        卡片 CRUD、激活、健康与操作状态
//   voiceReferences.ts 参考音频上传、试听流、删除、设主用
//   presentation.ts    主窗口表现快照与主资源切换
//   resources.ts       C3b 三类资源的能力句柄导入、导出、删除
import { Hono } from 'hono';
import type { FileAccessFacade } from '@ema-agent/attachment';
import type { CharacterCardStore } from '@ema-agent/characters';
import { cardCrudRoute } from './cards/cardCrud.js';
import { voiceReferencesRoute } from './cards/voiceReferences.js';
import { presentationRoute } from './cards/presentation.js';
import { characterResourcesRoute } from './cards/resources.js';

export function cardsRoute(
  cardStore: CharacterCardStore,
  fileAccess: Pick<FileAccessFacade, 'resolve'>,
): Hono {
  const app = new Hono();
  app.route('/', cardCrudRoute(cardStore));
  app.route('/', voiceReferencesRoute(cardStore));
  app.route('/', presentationRoute(cardStore));
  app.route('/', characterResourcesRoute(cardStore, fileAccess));
  return app;
}
