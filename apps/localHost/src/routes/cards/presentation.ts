// 主窗口表现快照与主资源切换的 HTTP 适配:候选顺序与 revision 由后端冻结。
import fs from 'node:fs';
import { Hono } from 'hono';
import {
  asCharacterCardId,
  asCharacterLive2dId,
  asCharacterPortraitId,
} from '@ema-agent/ids';
import { type CharacterCardStore } from '@ema-agent/characters';

function getCardOr404(cardStore: CharacterCardStore, idStr: string) {
  const id = asCharacterCardId(idStr);
  const card = cardStore.get(id);
  return card ? { id, card } : null;
}

/**
 * Endpoints:
 *   GET /:cardId/presentation       ordered main-window resource snapshot
 *   PUT /:cardId/live2d/primary     switch primary Live2D resource
 *   PUT /:cardId/portraits/primary  switch primary portrait resource
 */
export function presentationRoute(cardStore: CharacterCardStore): Hono {
  const app = new Hono();

  app.get('/:cardId/presentation', async (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    const health = await cardStore.inspectHealth(found.id, false);
    const candidates = [];

    for (const candidate of health.presentationCandidates) {
      if (candidate.kind === 'live2d') {
        const resource = found.card.live2dVariants.find(
          (item) => item.id === candidate.resourceId,
        );
        if (!resource) continue;
        candidates.push({
          kind: 'live2d' as const,
          resourceId: resource.id,
          label: resource.label,
          resourceRevision: `${resource.updatedAt}:${resource.contentSha256 ?? ''}`,
          sourcePath: stageResourcePath(
            cardStore,
            found.id,
            found.card.isBuiltin,
            resource.entryPath,
            'live2d',
          ),
          runtimeConfig: await readRuntimeConfig(
            cardStore,
            found.id,
            resource.runtimeConfigPath,
          ),
        });
        continue;
      }

      const resource = found.card.portraits.find(
        (item) => item.id === candidate.resourceId,
      );
      if (!resource) continue;
      candidates.push({
        kind: 'portrait' as const,
        resourceId: resource.id,
        label: resource.label,
        resourceRevision: `${resource.updatedAt}:${resource.contentSha256 ?? ''}`,
        sourcePath: stageResourcePath(
          cardStore,
          found.id,
          found.card.isBuiltin,
          resource.relativePath,
          'portrait',
        ),
        mimeType: resource.mimeType,
        width: resource.width,
        height: resource.height,
      });
    }

    return c.json({
      characterId: found.id,
      revision: presentationRevision(found.card),
      candidates,
      issues: health.issues,
    });
  });

  app.put('/:cardId/live2d/primary', async (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    const body = await c.req.json().catch(() => null) as { resourceId?: string } | null;
    if (!body || typeof body.resourceId !== 'string') {
      return c.json({ error: 'missing_resourceId' }, 400);
    }
    const resourceId = asCharacterLive2dId(body.resourceId);
    if (!cardStore.setPrimaryLive2dVariant(found.id, resourceId)) {
      return c.json({ error: 'live2d_not_found' }, 404);
    }
    return c.json({ primaryId: resourceId });
  });

  app.put('/:cardId/portraits/primary', async (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    const body = await c.req.json().catch(() => null) as { resourceId?: string } | null;
    if (!body || typeof body.resourceId !== 'string') {
      return c.json({ error: 'missing_resourceId' }, 400);
    }
    const resourceId = asCharacterPortraitId(body.resourceId);
    if (!cardStore.setPrimaryPortrait(found.id, resourceId)) {
      return c.json({ error: 'portrait_not_found' }, 404);
    }
    return c.json({ primaryId: resourceId });
  });

  return app;
}

function stageResourcePath(
  cardStore: CharacterCardStore,
  cardId: ReturnType<typeof asCharacterCardId>,
  isBuiltin: boolean,
  relativePath: string,
  kind: 'live2d' | 'portrait',
): string {
  const absolutePath = cardStore.resolveResourcePath(cardId, relativePath, kind);
  return isBuiltin ? `/cards/${cardId}/${relativePath}` : absolutePath;
}

async function readRuntimeConfig(
  cardStore: CharacterCardStore,
  cardId: ReturnType<typeof asCharacterCardId>,
  relativePath: string | null,
): Promise<unknown | null> {
  if (!relativePath) return null;
  try {
    const configPath = cardStore.resolveResourcePath(cardId, relativePath, 'live2d');
    const content = await fs.promises.readFile(configPath, 'utf-8');
    return JSON.parse(content) as unknown;
  } catch {
    // 模型本体仍可使用默认映射；配置故障不应把整个 Live2D 候选踢出降级链。
    return null;
  }
}

function presentationRevision(card: {
  updatedAt: number;
  live2dVariants: readonly {
    id: string;
    updatedAt: number;
    isPrimary: boolean;
    enabled: boolean;
  }[];
  portraits: readonly {
    id: string;
    updatedAt: number;
    isPrimary: boolean;
    enabled: boolean;
  }[];
}): string {
  const resources = [...card.live2dVariants, ...card.portraits]
    .map((resource) => [
      resource.id,
      resource.updatedAt,
      Number(resource.isPrimary),
      Number(resource.enabled),
    ].join(':'))
    .sort();
  return [card.updatedAt, ...resources].join('|');
}
