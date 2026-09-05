import { Hono } from 'hono';
import type { CharacterStore } from '@ema-agent/characters';
import { characterError } from './errors.js';

export interface CharacterPresentationRouteDeps {
  readonly characters: Pick<CharacterStore, 'inspectStagePresentation'>;
}

export const characterPresentationRoute = (deps: CharacterPresentationRouteDeps) =>
  new Hono().get('/:characterName/presentation', context => {
    try {
      return context.json(deps.characters.inspectStagePresentation(context.req.param('characterName')));
    } catch (error) {
      return characterError(context, error);
    }
  });
