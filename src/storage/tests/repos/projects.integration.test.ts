// 测试项目实体：文件夹主从语义、零文件夹，以及成员 cwd 独立性。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectsRepo } from '../../repos/data/projects.js';
import { SessionsRepo } from '../../repos/data/sessions.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('ProjectsRepo', () => {
  let database: TestDatabase;
  let projects: ProjectsRepo;
  let sessions: SessionsRepo;

  beforeEach(() => {
    database = createTestDatabase();
    projects = new ProjectsRepo(database.db);
    sessions = new SessionsRepo(database.db);
  });

  afterEach(() => database.close());

  it('首个文件夹自动为主；设为主要后按 updated_at 排在首位', () => {
    projects.insert({ id: 'p1', name: 'Demo', now: 1 });
    projects.addFolder('p1', 'D:/a');
    expect(projects.primaryFolderPath('p1')).toBe('D:/a');

    projects.addFolder('p1', 'D:/b');
    expect(projects.primaryFolderPath('p1')).toBe('D:/a');

    projects.setPrimaryFolder('p1', 'D:/b');
    expect(projects.primaryFolderPath('p1')).toBe('D:/b');
    expect(projects.listFolders('p1')[0]!.path).toBe('D:/b');
  });

  it('移除主文件夹后继位，但旧成员 cwd 不变', () => {
    projects.insert({ id: 'p1', name: 'Demo', now: 1 });
    projects.addFolder('p1', 'D:/a');
    projects.addFolder('p1', 'D:/b');
    sessions.insert({
      id: 's1', title: 's', projectId: 'p1', cwd: 'D:/a',
      createdAt: 1, updatedAt: 1,
    });

    projects.removeFolder('p1', 'D:/a');
    expect(projects.primaryFolderPath('p1')).toBe('D:/b');
    expect(sessions.findById('s1')?.cwd).toBe('D:/a');
  });

  it('最后一个文件夹可以移除，此时项目没有主文件夹', () => {
    projects.insert({ id: 'p1', name: 'Demo', now: 1 });
    projects.addFolder('p1', 'D:/a');
    projects.removeFolder('p1', 'D:/a');
    expect(projects.listFolders('p1')).toEqual([]);
    expect(projects.primaryFolderPath('p1')).toBeUndefined();
  });

  it('拖入、拖出、删除项目都不改写成员 cwd', () => {
    projects.insert({ id: 'p1', name: 'Demo', now: 1 });
    projects.addFolder('p1', 'D:/main');
    sessions.insert({ id: 's1', title: 's', cwd: 'D:/original', createdAt: 1, updatedAt: 1 });

    sessions.assignToProject('s1', 'p1', 2);
    expect(sessions.findById('s1')).toMatchObject({
      project_id: 'p1', cwd: 'D:/original',
    });

    sessions.removeFromProject('s1', 3);
    expect(sessions.findById('s1')).toMatchObject({
      project_id: null, cwd: 'D:/original',
    });

    sessions.assignToProject('s1', 'p1', 4);
    projects.remove('p1');
    expect(sessions.findById('s1')?.project_id).toBeNull();
  });
});
