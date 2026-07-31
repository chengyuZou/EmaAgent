// 隔离工作区文件浏览器的 Session/root 作用域，并阻止过期目录请求覆盖新状态。
export interface DirectoryRequestToken {
  path: string;
  generation: number;
}

export class DirectoryRequestGate {
  private readonly generations = new Map<string, number>();
  private active = true;

  begin(path: string): DirectoryRequestToken {
    const generation = (this.generations.get(path) ?? 0) + 1;
    this.generations.set(path, generation);
    return { path, generation };
  }

  isCurrent(token: DirectoryRequestToken): boolean {
    return this.active && this.generations.get(token.path) === token.generation;
  }

  dispose(): void {
    this.active = false;
    this.generations.clear();
  }
}

export function workspaceBrowserScopeKey(sessionId: string, root: string): string {
  return JSON.stringify([sessionId, root]);
}
