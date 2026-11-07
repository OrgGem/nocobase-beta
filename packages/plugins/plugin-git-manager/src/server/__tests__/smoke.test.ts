/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMockServer, type MockServer } from '@nocobase/test';
import PluginGitManagerServer from '../plugin';

describe('Git Manager HTTP integration', () => {
  let app: MockServer;
  let agent: ReturnType<MockServer['agent']>;
  let fixture: string;
  let repoPath: string;
  let repositoryId: number;
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
