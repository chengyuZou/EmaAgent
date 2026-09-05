// 角色集合 API：名称是稳定身份，切换与删除由应用层协调正在运行的工作。
import { Hono } from 'hono';
import { z } from 'zod';
import type { CharacterStore } from '@ema-agent/characters';
import { characterError } from './errors.js';
import { jsonBody } from '../validate.js';

export interface CharacterCollectionRouteDeps {
  readonly characters: Pick<CharacterStore, 'list' | 'current' | 'get' | 'create' | 'update'>;
  readonly activateCharacter: (characterName: string, terminateRunningWork: boolean) => Promise<void>;
  readonly deleteCharacter: (characterName: string, terminateRunningWork: boolean) => Promise<void>;
  readonly mutateCharacter: <T>(characterName: string, action: () => T | Promise<T>) => Promise<T>;
}

const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  description: z.string().max(2_000).nullable().optional(),
  personaPrompt: z.string().max(64_000),
});

const patchBody = z.object({
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  description: z.string().max(2_000).nullable().optional(),
  personaPrompt: z.string().max(64_000).optional(),
  stageKind: z.enum(['live2d', 'illustration', 'blank']).optional(),
});

const runningWorkBody = z.object({ terminateRunningWork: z.boolean().optional() });

export const characterCollectionRoute = (deps: CharacterCollectionRouteDeps) =>
  new Hono()
    .get('/', context => context.json({ items: deps.characters.list() }))
    .get('/current', context => context.json(deps.characters.current()))
    .get('/:characterName', context => {
      const character = deps.characters.get(context.req.param('characterName'));
      return character ? context.json(character) : context.json({ error: 'character_not_found' }, 404);
    })
    .post('/', jsonBody(createBody), context => {
      try {
        return context.json(deps.characters.create(context.req.valid('json')), 201);
      } catch (error) {
        return characterError(context, error);
      }
    })
    .patch('/:characterName', jsonBody(patchBody), async context => {
      const characterName = context.req.param('characterName');
      try {
        const character = await deps.mutateCharacter(
          characterName,
          () => deps.characters.update(characterName, context.req.valid('json')),
        );
        return context.json(character);
      } catch (error) {
        return characterError(context, error);
      }
    })
    .post('/:characterName/activate', jsonBody(runningWorkBody), async context => {
      try {
        await deps.activateCharacter(context.req.param('characterName'), context.req.valid('json').terminateRunningWork ?? false);
        return context.json({ ok: true });
      } catch (error) {
        return characterError(context, error);
      }
    })
    .delete('/:characterName', jsonBody(runningWorkBody), async context => {
      try {
        await deps.deleteCharacter(context.req.param('characterName'), context.req.valid('json').terminateRunningWork ?? false);
        return context.json({ ok: true });
      } catch (error) {
        return characterError(context, error);
      }
    });
