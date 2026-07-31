export class CharacterPromptInvalidError extends Error {
  readonly code = 'character_prompt_invalid';

  constructor(readonly characterId?: string) {
    super(characterId
      ? `character prompt is empty: ${characterId}`
      : 'character prompt is empty');
    this.name = 'CharacterPromptInvalidError';
  }
}

export class CharacterResourcePathError extends Error {
  readonly code = 'character_resource_path_invalid';

  constructor(
    readonly relativePath: string,
    readonly reason: string,
  ) {
    super(`invalid character resource path (${reason}): ${relativePath}`);
    this.name = 'CharacterResourcePathError';
  }
}
