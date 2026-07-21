// 这里定义 Skill 查询, 只读限制, 路径越界和目录碰撞错误.
export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`Skill "${name}" not found`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillReadonlyError extends Error {
  constructor(name: string) {
    super(`Skill "${name}" lives in a read-only root and cannot be modified`);
    this.name = 'SkillReadonlyError';
  }
}

export class SkillPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillPathError';
  }
}

export class SkillCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillCollisionError';
  }
}
