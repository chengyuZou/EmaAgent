// 测试项目实体：文件夹主从语义、继位级联、末位禁删、成员级联改写。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectsRepo, ProjectFolderError } from '../../repos/data/projects.js';
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

  it('移除主文件夹后最早添加者继位并级联成员工作区', () => {
    projects.insert({ id: 'p1', name: 'Demo', now: 1 });
    projects.addFolder('p1', 'D:/a');
    projects.addFolder('p1', 'D:/b');
    sessions.insert({
      id: 's1', title: 's', projectId: 'p1', workspaceRoot: 'D:/a',
      createdAt: 1, updatedAt: 1,
    });

    const result = projects.removeFolder('p1', 'D:/a');
    expect(result.newPrimaryPath).toBe('D:/b');
    sessions.cascadeWorkspaceForProject('p1', result.newPrimaryPath!, 2);
    expect(sessions.findById('s1')?.workspace_root).toBe('D:/b');
  });

  it('最后一个文件夹禁止移除', () => {
    projects.insert({ id: 'p1', name: 'Demo', now: 1 });
    projects.addFolder('p1', 'D:/a');
    expect(() => projects.removeFolder('p1', 'D:/a')).toThrow(ProjectFolderError);
  });

  it('拖入锁定主工作区，拖出保留工作区恢复自由，删项目成员掉回 NULL', () => {
    projects.insert({ id: 'p1', name: 'Demo', now: 1 });
    projects.addFolder('p1', 'D:/main');
    sessions.insert({ id: 's1', title: 's', createdAt: 1, updatedAt: 1 });

    sessions.assignToProject('s1', 'p1', 'D:/main', 2);
    expect(sessions.findById('s1')).toMatchObject({
      project_id: 'p1', workspace_root: 'D:/main',
    });

    sessions.removeFromProject('s1', 3);
    expect(sessions.findById('s1')).toMatchObject({
      project_id: null, workspace_root: 'D:/main',
    });

    sessions.assignToProject('s1', 'p1', 'D:/main', 4);
    projects.remove('p1');
    expect(sessions.findById('s1')?.project_id).toBeNull();
  });
});
