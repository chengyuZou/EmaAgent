// 主窗口表现快照与主资源切换的 HTTP 适配:候选顺序与 revision 由后端冻结。
import fs from 'node:fs';
import { Hono } from 'hono';
import {
  asCharacterCardId,
  asCharacterLive2dId,
  asCharacterIllustrationId,
} from '@ema-agent/ids';
import {
  findLive2dPackageFiles,
  type CharacterCardStore,
} from '@ema-agent/characters';

function getCardOr404(cardStore: CharacterCardStore, idStr: string) {
  const id = asCharacterCardId(idStr);
  const card = cardStore.get(id);
  return card ? { id, card } : null;
}

/**
 * Endpoints:
 *   GET /:cardId/presentation       ordered main-window resource snapshot
 *   PUT /:cardId/live2d/primary     switch primary Live2D resource
 *   PUT /:cardId/illustration/primary  switch primary illustration resource
 */
export function presentationRoute(cardStore: CharacterCardStore): Hono {
  const app = new Hono();

  app.get('/:cardId/presentation', async (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    const health = await cardStore.inspectHealth(found.id);
    const candidates = [];

    for (const candidate of health.presentationCandidates) {
      if (candidate.kind === 'live2d') {
        const resource = found.card.live2dVariants.find(
          (item) => item.id === candidate.resourceId,
        );
        if (!resource) continue;
        const directory = cardStore.resolveLive2dDirectory(found.id, resource.id);
        const files = await findLive2dPackageFiles(directory);
        candidates.push({
          kind: 'live2d' as const,
          resourceId: resource.id,
          name: resource.name,
          resourceRevision: String(resource.updatedAt),
          sourcePath: files.modelPath,
          runtimeConfig: await readRuntimeConfig(files.runtimeConfigPath),
          stageScale: resource.stageScale,
          stageOffsetX: resource.stageOffsetX,
          stageOffsetY: resource.stageOffsetY,
        });
        continue;
      }

      const resource = found.card.illustrations.find(
        (item) => item.id === candidate.resourceId,
      );
      if (!resource) continue;
      candidates.push({
        kind: 'illustration' as const,
        resourceId: resource.id,
        name: resource.name,
        resourceRevision: String(resource.updatedAt),
        sourcePath: cardStore.resolveIllustrationFile(found.id, resource.id),
        stageScale: resource.stageScale,
        stageOffsetX: resource.stageOffsetX,
        stageOffsetY: resource.stageOffsetY,
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

  app.put('/:cardId/illustration/primary', async (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    const body = await c.req.json().catch(() => null) as { resourceId?: string } | null;
    if (!body || typeof body.resourceId !== 'string') {
      return c.json({ error: 'missing_resourceId' }, 400);
    }
    const resourceId = asCharacterIllustrationId(body.resourceId);
    if (!cardStore.setPrimaryIllustration(found.id, resourceId)) {
      return c.json({ error: 'illustration_not_found' }, 404);
    }
    return c.json({ primaryId: resourceId });
  });

  return app;
}

async function readRuntimeConfig(configPath: string): Promise<unknown | null> {
  try {
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
  illustrations: readonly {
    id: string;
    updatedAt: number;
    isPrimary: boolean;
    enabled: boolean;
  }[];
}): string {
  const resources = [...card.live2dVariants, ...card.illustrations]
    .map((resource) => [
      resource.id,
      resource.updatedAt,
      Number(resource.isPrimary),
      Number(resource.enabled),
    ].join(':'))
    .sort();
  return [card.updatedAt, ...resources].join('|');
}
