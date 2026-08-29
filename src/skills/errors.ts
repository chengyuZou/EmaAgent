export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`Skill "${name}" not found`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillPathError';
  }
}
