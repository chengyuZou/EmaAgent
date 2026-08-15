// 项目实体与其源文件夹的 SQL 层：CRUD、置顶、主文件夹继位与成员级联。
// 成员 Session 的 workspace_root 级联改写由 SessionsRepo 的同连接方法在事务内完成。

import type { SqliteDb } from '../../database/database.js';

export interface ProjectRow {
  id: string;
  name: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}

export interface ProjectFolderRow {
  project_id: string;
  path: string;
  is_primary: number;
  created_at: number;
  /** 只在"设为主要"时写入；NULL = 从未当过主，排序时沉底。 */
  updated_at: number | null;
}

export class ProjectFolderError extends Error {
  readonly code = 'project_folder_error' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectFolderError';
  }
}

export class ProjectsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(project: { id: string; name: string; pinned?: boolean; now: number }): void {
    this.db
      .prepare('INSERT INTO projects (id, name, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.pinned ? 1 : 0, project.now, project.now);
  }

  findById(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  list(): ProjectRow[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY pinned DESC, updated_at DESC, id DESC')
      .all() as ProjectRow[];
  }

  rename(id: string, name: string, now: number): void {
    this.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id);
  }

  setPinned(id: string, pinned: boolean, now: number): void {
    this.db.prepare('UPDATE projects SET pinned = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, now, id);
  }

  /** 删除项目；成员 Session 由外键 SET NULL 掉到非项目区。 */
  remove(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  listFolders(projectId: string): ProjectFolderRow[] {
    return this.db
      .prepare(`SELECT * FROM project_folders WHERE project_id = ?
                ORDER BY updated_at DESC, created_at ASC, path ASC`)
      .all(projectId) as ProjectFolderRow[];
  }

  listAllFolders(): ProjectFolderRow[] {
    return this.db
      .prepare(`SELECT * FROM project_folders
                ORDER BY project_id, updated_at DESC, created_at ASC, path ASC`)
      .all() as ProjectFolderRow[];
  }

  primaryFolderPath(projectId: string): string | undefined {
    return this.db
      .prepare('SELECT path FROM project_folders WHERE project_id = ? AND is_primary = 1')
      .pluck().get(projectId) as string | undefined;
  }

  /** 追加文件夹；项目内的第一个文件夹自动成为主文件夹。 */
  addFolder(projectId: string, path: string): void {
    const now = Date.now();
    const primary = this.primaryFolderPath(projectId);
    this.db
      .prepare(
        `INSERT INTO project_folders (project_id, path, is_primary, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(projectId, path, primary === undefined ? 1 : 0, now);
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
  }

  /**
   * 移除文件夹。移除主文件夹时由排序首位者继位（最近为主者，或全空时最早添加者），
   * 返回新主路径供调用方级联改写成员；移除非主文件夹返回 null（无需级联）。
   * 最后一个文件夹禁止移除（无文件夹的项目是空壳）。
   */
  removeFolder(projectId: string, path: string): { newPrimaryPath: string | null } {
    const folders = this.listFolders(projectId);
    const target = folders.find((folder) => folder.path === path);
    if (!target) throw new ProjectFolderError(`项目文件夹不存在: ${path}`);
    if (folders.length === 1) {
      throw new ProjectFolderError('项目至少需要保留一个源文件夹');
    }

    this.db.prepare('DELETE FROM project_folders WHERE project_id = ? AND path = ?')
      .run(projectId, path);

    if (target.is_primary !== 1) return { newPrimaryPath: null };
    const successor = this.listFolders(projectId)[0]!;
    this.db.prepare('UPDATE project_folders SET is_primary = 1, updated_at = ? WHERE project_id = ? AND path = ?')
      .run(Date.now(), projectId, successor.path);
    return { newPrimaryPath: successor.path };
  }

  /** 更换主文件夹；调用方负责把新主路径级联改写成员 workspace_root。 */
  setPrimaryFolder(projectId: string, path: string): void {
    const folders = this.listFolders(projectId);
    if (!folders.some((folder) => folder.path === path)) {
      throw new ProjectFolderError(`项目文件夹不存在: ${path}`);
    }
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('UPDATE project_folders SET is_primary = 0 WHERE project_id = ?').run(projectId);
      this.db.prepare('UPDATE project_folders SET is_primary = 1, updated_at = ? WHERE project_id = ? AND path = ?')
        .run(now, projectId, path);
    })();
  }
}
