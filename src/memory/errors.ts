export class MemoryConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryConsolidationError';
  }
}
