// 角色集合：列表、当前角色、创建/更新/激活/复制/删除。
import { Hono } from 'hono';
import { z } from 'zod';
import type { CharacterStore } from '@ema-agent/characters';
import { characterError } from './errors.js';
import { jsonBody } from '../validate.js';

export interface CharacterCollectionRouteDeps {
  readonly characters: Pick<
    CharacterStore,
    'list' | 'current' | 'get' | 'create' | 'update' | 'activate' | 'duplicate' | 'deleteManagedCharacter'
  >;
}

const createBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2_000).nullish(),
  personaPrompt: z.string().max(64_000),
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2_000).nullish(),
  personaPrompt: z.string().max(64_000).optional(),
});

export const characterCollectionRoute = (deps: CharacterCollectionRouteDeps) =>
  new Hono()
    .get('/', context => context.json({ items: deps.characters.list() }))
    .get('/current', context => context.json(deps.characters.current()))
    .get('/:id', context => {
      const character = deps.characters.get(context.req.param('id'));
      if (!character) return context.json({ error: 'character_not_found' }, 404);
      return context.json(character);
    })
    .post('/', jsonBody(createBody), async context => {
      const { name, description, personaPrompt } = context.req.valid('json');
      try {
        return context.json(deps.characters.create({
          name,
          description: description ?? null,
          personaPrompt,
        }), 201);
      } catch (error) {
        return characterError(context, error);
      }
    })
    .patch('/:id', jsonBody(patchBody), async context => {
      try {
        return context.json(deps.characters.update(context.req.param('id'), context.req.valid('json')));
      } catch (error) {
        return characterError(context, error);
      }
    })
    .post('/:id/activate', context => {
      try {
        deps.characters.activate(context.req.param('id'));
        return context.json({ ok: true });
      } catch (error) {
        return characterError(context, error);
      }
    })
    .post('/:id/duplicate', context => {
      try {
        return context.json(deps.characters.duplicate(context.req.param('id')), 201);
      } catch (error) {
        return characterError(context, error);
      }
    })
    .delete('/:id', async context => {
      try {
        await deps.characters.deleteManagedCharacter(context.req.param('id'));
        return context.json({ ok: true });
      } catch (error) {
        return characterError(context, error);
      }
    });
