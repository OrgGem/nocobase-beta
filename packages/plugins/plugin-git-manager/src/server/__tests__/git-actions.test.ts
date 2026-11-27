// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Context } from '@nocobase/actions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clone,
  fileContent,
  fileTree,
  getRepo,
  installGit,
  resetGitBinaryCacheForTests,
  runtimeStatus,
  validateRepoRelativePath,
  withAuth,
} from '../actions/git-actions';
import { mergeRequestDetail, mergeRequestNotes, readChatMergeRequest } from '../actions/gitlab-api';
import { subtreeOptions } from '../actions/subtree';
import { resolveReviewSource } from '../services/review-source';
import { resetClusterGitDispatchCooldownForTests } from '../utils/cluster-git';

const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

function createThrower() {
  return vi.fn((status: number, message: string): never => {
    throw Object.assign(new Error(message), { status });
  });
}

describe('Git Manager git actions & security fixes', () => {
  let fixture: string;
  const originalBase = process.env.GIT_REPOS_BASE_PATH;
  const originalGitBinary = process.env.GIT_BINARY_PATH;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'git-actions-test-'));
    process.env.GIT_REPOS_BASE_PATH = fixture;
    delete process.env.GIT_BINARY_PATH;
    resetGitBinaryCacheForTests();
    resetClusterGitDispatchCooldownForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalBase === undefined) delete process.env.GIT_REPOS_BASE_PATH;
    else process.env.GIT_REPOS_BASE_PATH = originalBase;
    if (originalGitBinary === undefined) delete process.env.GIT_BINARY_PATH;
    else process.env.GIT_BINARY_PATH = originalGitBinary;
    resetGitBinaryCacheForTests();
    resetClusterGitDispatchCooldownForTests();
    rmSync(fixture, { recursive: true, force: true });
  });

  it('uses the repository ID from the request body over the URL parameter', async () => {
    const repository = { id: 20 };
    const findOne = vi.fn().mockResolvedValue(repository);
    const context = {
      action: { params: { repositoryId: 10 } },
      request: { body: { repositoryId: 20 } },
      db: {
        getRepository: vi.fn().mockReturnValue({ findOne }),
      },
      throw: createThrower(),
    };

    const result = await getRepo(context as unknown as Context);

    expect(findOne).toHaveBeenCalledWith({ filterByTk: 20 });
    expect(result).toBe(repository);
  });

  it.each(['../../../other-org/secret-repo/pulls/1', '../variables', '0', '-4', '12/files', 'abc'])(
    'blocks path traversal and non-integer mrIid (%s) before calling provider API',
    async (badMrIid) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const repoRecord = record({ id: 1, gitAccountId: 1, repoUrl: 'https://github.com/org/allowed-repo.git' });
      const accountRecord = record({ provider: 'github', baseUrl: null, pat: 'ghp_secret', username: 'bot' });
      const db = {
        getRepository: (name: string) => ({
          findOne: async () => (name === 'gitAccounts' ? accountRecord : repoRecord),
        }),
      };

      const makeCtx = () =>
        ({
          db,
          action: { params: { repositoryId: 1, mrIid: badMrIid } },
          throw: createThrower(),
        }) as unknown as Context;

      await expect(mergeRequestDetail(makeCtx(), async () => {})).rejects.toMatchObject({
        status: 400,
        message: 'Invalid merge request ID',
      });
      await expect(mergeRequestNotes(makeCtx(), async () => {})).rejects.toMatchObject({
        status: 400,
        message: 'Invalid merge request ID',
      });
      await expect(readChatMergeRequest(makeCtx(), badMrIid as unknown as number, 1)).rejects.toMatchObject({
        status: 400,
        message: 'Invalid merge request ID',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('validates repository-relative paths by segment while allowing filenames containing double dots', () => {
    expect(validateRepoRelativePath('docs/v1..v2-migration.md')).toBe('docs/v1..v2-migration.md');
    expect(validateRepoRelativePath('/src/index.ts/')).toBe('src/index.ts');
    for (const unsafe of ['../secret', 'src/../../etc/passwd', 'src/./file.ts', 'C:/windows/win.ini', 'bad\0file.ts']) {
      expect(() => validateRepoRelativePath(unsafe)).toThrow('Invalid file path');
    }
  });

  it('reads UTF-8 Vietnamese filenames without octal quoting in fileTree and fileContent', async () => {
    const repoDir = join(fixture, 'utf8-repo');
    mkdirSync(repoDir);
    execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' });
    const utf8File = 'tài-liệu..v2.md';
    writeFileSync(join(repoDir, utf8File), 'Xin chào NocoBase', 'utf8');
    execFileSync('git', ['-C', repoDir, 'add', utf8File], { stdio: 'ignore' });
    execFileSync(
      'git',
      ['-C', repoDir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'utf8'],
      { stdio: 'ignore' },
    );

    const repoRecord = record({ id: 1, localPath: 'utf8-repo', repoUrl: 'https://github.com/org/utf8.git' });
    const db = {
      getRepository: () => ({ findOne: async () => repoRecord }),
    };

    const treeCtx = {
      db,
      action: { params: { repositoryId: 1, ref: 'HEAD' } },
      body: undefined as unknown,
      throw: createThrower(),
    };
    await fileTree(treeCtx as unknown as Context, async () => {});
    const treeItems = (treeCtx.body as { data: Array<{ name: string; path: string }> }).data;
    expect(treeItems).toEqual([expect.objectContaining({ name: utf8File, path: utf8File })]);

    const contentCtx = {
      db,
      action: { params: { repositoryId: 1, ref: 'HEAD', filePath: utf8File } },
      body: undefined as unknown,
      throw: createThrower(),
    };
    await fileContent(contentCtx as unknown as Context, async () => {});
    expect(contentCtx.body).toMatchObject({
      success: true,
      data: { content: 'Xin chào NocoBase', filePath: utf8File, ref: 'HEAD' },
    });
  });

  it('uses distributed lockManager in withAuth and skips rewriting remote URL when unchanged', async () => {
    const runExclusive = vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn());
    const git = {
      env: vi.fn(),
      raw: vi.fn().mockResolvedValue('https://github.com/org/repo.git\n'),
      remote: vi.fn(),
    };

    const result = await withAuth(
      git as never,
      join(fixture, 'locked-repo'),
      'https://github.com/org/repo.git',
      'ghp_token',
      async () => 'ok',
      'bot',
      'origin',
      { runExclusive },
    );

    expect(result).toBe('ok');
    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(git.remote).not.toHaveBeenCalled();
  });

  it('reports accurate missing-directory and missing-git errors in subtree and review-source', async () => {
    const repoRecord = record({
      id: 1,
      gitAccountId: 1,
      localPath: 'not-cloned-yet',
      repoUrl: 'https://github.com/org/repo.git',
      defaultBranch: 'main',
    });
    const accountRecord = record({ provider: 'github', baseUrl: null, pat: 'ghp_token', username: 'bot' });
    const db = {
      getRepository: (name: string) => ({
        findOne: async () => (name === 'gitAccounts' ? accountRecord : repoRecord),
      }),
    };

    const subtreeCtx = {
      db,
      action: { params: { repositoryId: 1 } },
      t: (msg: string) => msg,
      throw: createThrower(),
    };
    await expect(subtreeOptions(subtreeCtx as unknown as Context, async () => {})).rejects.toMatchObject({
      status: 400,
      message: 'Repository directory does not exist. Please clone the repository first.',
    });

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: 99, html_url: 'https://github.com/org/repo' }), { status: 200 }),
        ),
    );
    await expect(
      resolveReviewSource(db as never, repoRecord, { targetType: 'branch', branch: 'main' }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Repository directory does not exist. Please clone the repository first.',
    });
  });

  it('reconnects an existing matching git directory during clone instead of failing with directory exists', async () => {
    const remoteBare = join(fixture, 'remote.git');
    const existingClone = join(fixture, 'existing-clone');
    mkdirSync(remoteBare);
    mkdirSync(existingClone);
    execFileSync('git', ['init', '--bare', remoteBare], { stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main', existingClone], { stdio: 'ignore' });
    execFileSync('git', ['-C', existingClone, 'remote', 'add', 'origin', 'https://github.com/org/repo.git'], {
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-C',
        existingClone,
        'config',
        `url.${remoteBare.replace(/\\/g, '/')}.insteadOf`,
        'https://github.com/org/repo.git',
      ],
      { stdio: 'ignore' },
    );

    const update = vi.fn().mockResolvedValue(undefined);
    const repoRecord = record({
      id: 5,
      gitAccountId: 1,
      localPath: 'existing-clone',
      repoUrl: 'https://github.com/org/repo.git',
      defaultBranch: 'main',
    });
    const accountRecord = record({ provider: 'github', baseUrl: null, pat: 'ghp_token', username: 'bot' });

    const ctx = {
      db: {
        getRepository: (name: string) => ({
          findOne: async () => (name === 'gitAccounts' ? accountRecord : repoRecord),
          update,
        }),
      },
      action: { params: { repositoryId: 5 } },
      body: undefined as unknown,
      throw: createThrower(),
    };

    await clone(ctx as unknown as Context, async () => {});
    expect(update).toHaveBeenCalledWith({ filterByTk: 5, values: { status: 'connected' } });
    expect(ctx.body).toMatchObject({ success: true, message: 'Repository reconnected successfully' });
    expect(existsSync(existingClone)).toBe(true);
  });

  it('auto-dispatches Cluster Manager git installation when git is missing and recovers dynamically once installed', async () => {
    const missingBin = join(fixture, 'missing-git-bin');
    process.env.GIT_BINARY_PATH = missingBin;
    resetGitBinaryCacheForTests();

    const publish = vi.fn().mockResolvedValue(undefined);
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    const pkgConfig = record({
      id: 1,
      aptPackages: 'python3\ngit',
      initStatus: 'succeeded',
      lastInitAt: '2026-11-25T19:02:33.000Z',
      initProgressPercent: 100,
      aptMirrorUrl: '',
    });

    const app = {
      pm: { get: (name: string) => (name === 'plugin-cluster-manager' ? {} : undefined) },
      db: {
        getCollection: (name: string) => (name === 'workerPackagesConfigs' ? {} : undefined),
        getRepository: (name: string) =>
          name === 'workerPackagesConfigs'
            ? { findOne: async () => pkgConfig, create: vi.fn(), update: updateConfig }
            : undefined,
      },
      pubSubManager: { isConnected: async () => true, publish },
    };

    const statusCtx = {
      app,
      body: undefined as unknown,
      throw: createThrower(),
    };
    await runtimeStatus(statusCtx as unknown as Context, async () => {});

    expect(publish).toHaveBeenCalledWith('cluster-manager.install-packages', {
      targetRole: 'all',
      packages: { apt: ['git'] },
      registryConfig: { aptMirrorUrl: undefined },
    });
    expect(statusCtx.body).toMatchObject({
      success: true,
      data: {
        gitAvailable: false,
        clusterManager: { available: true, gitConfigured: true, status: 'running' },
      },
    });

    // Simulate Cluster Manager finishing git installation on the running node without restarting the server
    delete process.env.GIT_BINARY_PATH;
    const recoveredCtx = {
      app,
      body: undefined as unknown,
      throw: createThrower(),
    };
    await runtimeStatus(recoveredCtx as unknown as Context, async () => {});
    expect(recoveredCtx.body).toMatchObject({
      success: true,
      data: { gitAvailable: true },
    });

    const installCtx = {
      app,
      body: undefined as unknown,
      throw: createThrower(),
    };
    await installGit(installCtx as unknown as Context, async () => {});
    expect(installCtx.body).toMatchObject({
      success: true,
      data: { alreadyInstalled: true },
    });
  });
});
