export class MemoryNoteEmptyError extends Error {
  constructor() {
    super('Memory note cannot be empty');
    this.name = 'MemoryNoteEmptyError';
  }
}

export class MemoryNoteCharacterRequiredError extends Error {
  constructor() {
    super('Current character is required for a character memory note');
    this.name = 'MemoryNoteCharacterRequiredError';
  }
}

export class MemoryNoteAlreadyExistsError extends Error {
  constructor(readonly filePath: string) {
    super(`Memory note already exists: ${filePath}`);
    this.name = 'MemoryNoteAlreadyExistsError';
  }
}
