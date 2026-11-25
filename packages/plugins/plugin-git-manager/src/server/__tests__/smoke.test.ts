// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMockServer, type MockServer } from '@nocobase/test';
import { UNION_ROLE_KEY } from '../../../../@nocobase/plugin-acl/src/server/constants';
import { SystemRoleMode } from '../../../../@nocobase/plugin-acl/src/server/enum';
import PluginGitManagerServer from '../plugin';

describe('Git Manager HTTP integration', () => {
  let app: MockServer;
  let agent: ReturnType<MockServer['agent']>;
  let fixture: string;
  let repoPath: string;
  let repositoryId: number;
  let otherRepositoryId: number;
  let rootCommitHash: string;
  const originalBase = process.env.GIT_REPOS_BASE_PATH;

  beforeAll(async () => {
    fixture = mkdtempSync(join(tmpdir(), 'git-manager-http-'));
    repoPath = join(fixture, 'repository');
    mkdirSync(repoPath);
    process.env.GIT_REPOS_BASE_PATH = fixture;
    execFileSync('git', ['init', '-b', 'main', repoPath], { stdio: 'ignore' });
    execFileSync(
      'git',
      [
        '-C',
        repoPath,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ],
      { stdio: 'ignore' },
    );
    execFileSync('git', ['-C', repoPath, 'branch', 'marker'], { stdio: 'ignore' });
    rootCommitHash = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    app = await createMockServer({
      acl: true,
      registerActions: true,
      plugins: [
        'field-sort',
        'system-settings',
        'users',
        'auth',
        'acl',
        'data-source-manager',
        'data-source-main',
        'error-handler',
        [PluginGitManagerServer, { name: 'plugin-git-manager' }],
      ],
    });
    const repository = await app.db.getRepository('gitRepositories').create({
      values: { name: 'fixture', localPath: 'repository', repoUrl: 'https://gitlab.com/team/fixture.git' },
    });
    repositoryId = repository.get('id');
    const otherRepoPath = join(fixture, 'other-repository');
    mkdirSync(otherRepoPath);
    execFileSync('git', ['init', '-b', 'main', otherRepoPath], { stdio: 'ignore' });
    execFileSync(
      'git',
      [
        '-C',
        otherRepoPath,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'other fixture',
      ],
      { stdio: 'ignore' },
    );
    const otherRepository = await app.db.getRepository('gitRepositories').create({
      values: { name: 'other-fixture', localPath: 'other-repository', repoUrl: 'https://gitlab.com/team/other.git' },
    });
    otherRepositoryId = otherRepository.get('id');
    agent = await app.agent().login(await app.db.getRepository('users').findOne());
  });

  afterAll(async () => {
    await app?.destroy();
    if (originalBase === undefined) delete process.env.GIT_REPOS_BASE_PATH;
    else process.env.GIT_REPOS_BASE_PATH = originalBase;
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it('loads the actual plugin, collection and resource handler', async () => {
    expect(app.pm.get('plugin-git-manager')).toBeInstanceOf(PluginGitManagerServer);
    expect(app.db.getCollection('gitRepositories')).toBeTruthy();
    const response = await agent.get('/gitManager:pollerStatus');
    expect(response.status).toBe(200);
    expect(response.body.data).toBeTruthy();
  });

  it('filters chat context options and rechecks content against SQLite ACL scopes', async () => {
    const createReaderAgent = async (
      roleName: string,
      includeCommitActions: boolean,
      fields = ['id', 'name', 'defaultBranch', 'status'],
    ) => {
      await app.db.getRepository('roles').create({ values: { name: roleName } });
      const scope = await agent.resource('dataSourcesRolesResourcesScopes').create({
        values: {
          name: `${roleName} repository scope`,
          resourceName: 'gitRepositories',
          scope: { $and: [{ id: { $in: [repositoryId] } }] },
        },
      });
      const scopeId = scope.body.data.id;
      const repositoryResource = {
        name: 'gitRepositories',
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields, scopeId },
          { name: 'get', fields, scopeId },
        ],
      };
      await agent.resource('roles.resources', roleName).create({ values: repositoryResource });
      if (includeCommitActions) {
        const commitResource = {
          name: 'gitManager',
          usingActionsConfig: true,
          actions: ['branches', 'log', 'commitDetail', 'diff'].map((name) => ({ name, scopeId })),
        };
        await agent.resource('roles.resources', roleName).create({ values: commitResource });
      }
      const user = await app.db.getRepository('users').create({ values: { roles: [roleName] } });
      return app.agent().login(user);
    };

    const repoReader = await createReaderAgent('git-chat-repo-reader', false);
    const repoResponse = await repoReader.get('/gitManager:chatContextOptions').query({ kind: 'repository' });
    expect(repoResponse.status).toBe(200);
    const repoPayload = repoResponse.body.data.data as {
      capabilities: Record<string, boolean>;
      items: Array<Record<string, unknown>>;
    };
    expect(repoPayload.capabilities.repository).toBe(true);
    expect(repoPayload.capabilities.commit).toBe(false);
    expect(repoPayload.capabilities['merge-request']).toBe(false);
    expect(repoPayload.items).toEqual([
      { id: repositoryId, name: 'fixture', defaultBranch: 'main', status: expect.any(String) },
    ]);
    expect(JSON.stringify(repoResponse.body)).not.toContain('localPath');
    expect(JSON.stringify(repoResponse.body)).not.toContain('repoUrl');

    const commitReader = await createReaderAgent('git-chat-commit-reader', true);
    const commitOptions = await commitReader
      .get('/gitManager:chatContextOptions')
      .query({ kind: 'commit', repositoryId, pageSize: 1 });
    expect(commitOptions.status).toBe(200);
    const commitPayload = commitOptions.body.data.data as {
      capabilities: Record<string, boolean>;
      items: Array<{ id: number }>;
    };
    expect(commitPayload.capabilities.commit).toBe(true);
    expect(commitPayload.items.map((item) => item.id)).toEqual([repositoryId]);

    const unauthorizedPreselection = await commitReader
      .get('/gitManager:chatContextOptions')
      .query({ kind: 'commit', repositoryId: otherRepositoryId, pageSize: 1 });
    expect(unauthorizedPreselection.status).toBe(200);
    expect(unauthorizedPreselection.body.data.data.items).toEqual([]);

    const authorizedContent = await commitReader.get('/gitManager:chatContextContent').query({
      kind: 'commit',
      repositoryId,
      commitHash: rootCommitHash,
    });
    expect(authorizedContent.status).toBe(200);
    const content = authorizedContent.body.data.data as Record<string, unknown>;
    expect(content).toMatchObject({
      type: 'git-commit',
      repositoryId: String(repositoryId),
      commitSha: rootCommitHash,
    });
    expect(JSON.stringify(authorizedContent.body)).not.toContain('localPath');
    expect(JSON.stringify(authorizedContent.body)).not.toContain('repoUrl');

    const revokedContent = await commitReader.get('/gitManager:chatContextContent').query({
      kind: 'commit',
      repositoryId: otherRepositoryId,
      commitHash: rootCommitHash,
    });
    expect(revokedContent.status).toBe(403);

    const hiddenNameReader = await createReaderAgent('git-chat-hidden-name-reader', false, [
      'id',
      'defaultBranch',
      'status',
    ]);
    const visibleFields = await hiddenNameReader.get('/gitManager:chatContextOptions').query({ kind: 'repository' });
    expect(visibleFields.status).toBe(200);
    expect(visibleFields.body.data.data.items).toEqual([
      { id: repositoryId, defaultBranch: 'main', status: expect.any(String) },
    ]);
    const hiddenNameSearch = await hiddenNameReader
      .get('/gitManager:chatContextOptions')
      .query({ kind: 'repository', search: 'fixture' });
    expect(hiddenNameSearch.status).toBe(200);
    expect(hiddenNameSearch.body.data.data.items).toEqual([]);
  });

  it('combines repository and Git action permissions from current union roles', async () => {
    const repositoryRole = 'git-chat-union-repository-reader';
    const commitRole = 'git-chat-union-commit-reader';
    await app.db.getRepository('roles').create({ values: { name: repositoryRole } });
    await app.db.getRepository('roles').create({ values: { name: commitRole } });
    const scope = await agent.resource('dataSourcesRolesResourcesScopes').create({
      values: {
        name: 'Git chat union repository scope',
        resourceName: 'gitRepositories',
        scope: { $and: [{ id: { $in: [repositoryId] } }] },
      },
    });
    const scopeId = scope.body.data.id;
    await agent.resource('roles.resources', repositoryRole).create({
      values: {
        name: 'gitRepositories',
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['id', 'name', 'defaultBranch', 'status'], scopeId },
          { name: 'get', fields: ['id', 'name', 'defaultBranch', 'status'], scopeId },
        ],
      },
    });
    await agent.resource('roles.resources', commitRole).create({
      values: {
        name: 'gitManager',
        usingActionsConfig: true,
        actions: ['branches', 'log', 'commitDetail', 'diff'].map((name) => ({ name, scopeId })),
      },
    });
    const unionUser = await app.db.getRepository('users').create({
      values: { roles: [repositoryRole, commitRole] },
    });

    await agent.resource('roles').setSystemRoleMode({ values: { roleMode: SystemRoleMode.allowUseUnion } });
    try {
      const unionAgent = await app.agent().login(unionUser, UNION_ROLE_KEY);
      const response = await unionAgent
        .get('/gitManager:chatContextOptions')
        .query({ kind: 'commit', repositoryId, pageSize: 1 });

      expect(response.status).toBe(200);
      expect(response.body.data.data.capabilities.commit).toBe(true);
      expect(response.body.data.data.items).toEqual([
        { id: repositoryId, name: 'fixture', defaultBranch: 'main', status: expect.any(String) },
      ]);
    } finally {
      await agent.resource('roles').setSystemRoleMode({ values: { roleMode: SystemRoleMode.default } });
    }
  });

  it('does not expose Git context capabilities to an authenticated user without Git permissions', async () => {
    await app.db.getRepository('roles').create({ values: { name: 'git-chat-no-access' } });
    const user = await app.db.getRepository('users').create({ values: { roles: ['git-chat-no-access'] } });
    const noGitAgent = await app.agent().login(user);

    const response = await noGitAgent.get('/gitManager:chatContextOptions');

    expect(response.status).toBe(200);
    expect(response.body.data.data.capabilities).toEqual({ repository: false, 'merge-request': false, commit: false });
    expect(response.body.data.data.items).toEqual([]);
  });

  it.each([
    'clone',
    'pull',
    'push',
    'fetch',
    'checkout',
    'triggerReview',
    'reviewApprovePost',
    'reviewReject',
    'pollNow',
    'updateRolePermissions',
    'subtreePreview',
    'subtreeOptions',
    'subtreeRun',
    'subtreeReplace',
  ])('rejects GET on %s before executing it', async (action) => {
    const response = await agent.get(`/gitManager:${action}`).query({ repositoryId, branch: 'marker' });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
    expect(execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('main');
  });

  it('rejects a junction escaping the configured root through the real POST handler', async () => {
    const confinedBase = join(fixture, 'confined');
    mkdirSync(confinedBase);
    const alias = join(confinedBase, 'alias');
    symlinkSync(repoPath, alias, 'junction');
    process.env.GIT_REPOS_BASE_PATH = confinedBase;
    try {
      const escaped = await app.db.getRepository('gitRepositories').create({
        values: { name: 'escaped', localPath: 'alias', repoUrl: 'https://gitlab.com/team/fixture.git' },
      });
      const response = await agent
        .post('/gitManager:checkout')
        .send({ repositoryId: escaped.get('id'), branch: 'marker' });
      expect(response.status).toBe(400);
      expect(execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe(
        'main',
      );
    } finally {
      process.env.GIT_REPOS_BASE_PATH = fixture;
      unlinkSync(alias);
    }
  });

  it('rejects HEAD and still allows authorized POST checkout', async () => {
    const head = await agent.head('/gitManager:checkout').query({ repositoryId, branch: 'marker' });
    expect(head.status).toBe(405);
    const post = await agent.post('/gitManager:checkout').send({ repositoryId, branch: 'marker' });
    expect(post.status).toBe(200);
    expect(execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe(
      'marker',
    );
  });
});
