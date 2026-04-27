declare module "node:sqlite" {
  export interface StatementResultingChanges {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface StatementSync {
    run(params?: Record<string, unknown> | unknown[]): StatementResultingChanges;
    get<T = unknown>(params?: Record<string, unknown> | unknown[]): T | undefined;
    all<T = unknown>(params?: Record<string, unknown> | unknown[]): T[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
