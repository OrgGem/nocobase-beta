/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Context } from '@nocobase/actions';
import type { SimpleGit } from 'simple-git';
import { createGit, credentialEnvironment, validateLocalPath, withAuth } from '../actions/git-actions';
import { mergeRequests } from '../actions/gitlab-api';
import { getRepoAccount } from '../utils/get-repo-account';

const repoUrl = 'https://trusted.invalid/team/project.git';
const fakePat = 'test-only-secret';
const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

function database(url = repoUrl, baseUrl: string | null = 'https://trusted.invalid', provider = 'gitlab') {
  const repo = record({ gitAccountId: 1, repoUrl: url });
  return {
    repo,
    db: {
      getRepository: (name: string) => ({
        findOne: async () => (name === 'gitAccounts' ? record({ baseUrl, provider, pat: fakePat }) : repo),
      }),
    },
  };
}

describe('Git credential destination', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['https://different.invalid/team/r', 'https://trusted.invalid', 'gitlab'],
    ['http://trusted.invalid/team/r', 'https://trusted.invalid', 'gitlab'],
    ['https://trusted.invalid:444/team/r', 'https://trusted.invalid', 'gitlab'],
    ['https://selfhost.invalid/team/r', null, 'gitlab'],
    ['https://enterprise.invalid/team/r', 'https://enterprise.invalid', 'github'],
  ])('rejects an untrusted credential destination %s', async (url, baseUrl, provider) => {
    const { db, repo } = database(url, baseUrl, provider);
    await expect(getRepoAccount(db, repo)).rejects.toThrow();
  });

  it.each([
    [repoUrl, 'https://trusted.invalid', 'gitlab'],
    ['https://gitlab.com/team/r', null, 'gitlab'],
    ['https://github.com/team/r', null, 'github'],
  ])('accepts an explicitly bound or public default origin %s', async (url, baseUrl, provider) => {
    const { db, repo } = database(url, baseUrl, provider);
    await expect(getRepoAccount(db, repo)).resolves.toMatchObject({ pat: fakePat });
  });

  it('blocks the API request before sending a token to a mismatched repository host', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { db } = database('https://different.invalid/team/r');
    await expect(
      mergeRequests({ db, action: { params: { repositoryId: 1 } } } as unknown as Context, async () => {}),
    ).rejects.toThrow('Repository URL must match');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [repoUrl, 'https://trusted.invalid', 'gitlab'],
    ['https://github.com/team/r', null, 'github'],
  ])('disables redirects for authenticated provider API requests', async (url, baseUrl, provider) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const { db } = database(url, baseUrl, provider);
    await mergeRequests({ db, action: { params: { repositoryId: 1 } } } as unknown as Context, async () => {});
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error' }));
  });
});

describe('Git filesystem and process credentials', () => {
  let fixture: string;
  let base: string;
  const originalBase = process.env.GIT_REPOS_BASE_PATH;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'git-manager-security-'));
    base = join(fixture, 'base');
    mkdirSync(base);
    process.env.GIT_REPOS_BASE_PATH = base;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalBase === undefined) delete process.env.GIT_REPOS_BASE_PATH;
    else process.env.GIT_REPOS_BASE_PATH = originalBase;
    rmSync(fixture, { recursive: true, force: true });
  });

  it('rejects base itself, traversal, junction escapes and new clones below a junction', () => {
    const outside = join(fixture, 'outside');
    mkdirSync(outside);
    const alias = join(base, 'alias');
    symlinkSync(outside, alias, 'junction');
    try {
      for (const candidate of ['.', '../outside', 'alias', 'alias/new/clone']) {
        expect(() => validateLocalPath(candidate)).toThrow('Invalid local path');
      }
      expect(validateLocalPath('nested/new')).toBe(join(base, 'nested/new'));
    } finally {
      unlinkSync(alias);
    }
  });

  it('releases the lock when the initial remote setup fails', async () => {
    const git = {
      env: vi.fn(),
      remote: vi.fn().mockRejectedValueOnce(new Error('setup failed')).mockResolvedValue(''),
    };
    const operation = vi.fn().mockResolvedValue('done');
    await expect(withAuth(git as unknown as SimpleGit, base, repoUrl, fakePat, operation)).rejects.toThrow(
      'setup failed',
    );
    await expect(withAuth(git as unknown as SimpleGit, base, repoUrl, fakePat, operation)).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(git.env.mock.calls.at(-1)?.[0]).not.toHaveProperty('GIT_CONFIG_COUNT');
  });

  it('releases the lock even if credential setup fails', async () => {
    const git = {
      env: vi.fn().mockImplementationOnce(() => {
        throw new Error('env failed');
      }),
      remote: vi.fn(),
    };
    await expect(withAuth(git as unknown as SimpleGit, base, repoUrl, fakePat, async () => true)).rejects.toThrow(
      'env failed',
    );
    await expect(withAuth(git as unknown as SimpleGit, base, repoUrl, fakePat, async () => true)).resolves.toBe(true);
  });

  it('never writes PAT or the authorization header into Git config, including on operation failure', async () => {
    execFileSync('git', ['init', base], { stdio: 'ignore' });
    const git = createGit(base);
    await git.addRemote('origin', repoUrl);
    const authorization = Buffer.from(`oauth2:${fakePat}`).toString('base64');
    await expect(
      withAuth(git, base, repoUrl, fakePat, async () => {
        const config = readFileSync(join(base, '.git/config'), 'utf8');
        expect(config).not.toContain(fakePat);
        expect(config).not.toContain(authorization);
        throw new Error(`failure ${fakePat} ${authorization}`);
      }),
    ).rejects.toThrow('failure *** ***');
    expect(readFileSync(join(base, '.git/config'), 'utf8')).not.toContain(fakePat);
    await expect(withAuth(git, base, repoUrl, fakePat, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('scopes the auth header to the trusted repository and disables Git redirects', () => {
    const env = credentialEnvironment(repoUrl, fakePat);
    const config = (url: string) =>
      execFileSync('git', ['config', '--get-urlmatch', 'http', url], { env, encoding: 'utf8' });
    expect(config(`${repoUrl}/info/refs`)).toContain('Authorization: Basic');
    expect(config('https://different.invalid/team/project.git/info/refs')).not.toContain('Authorization: Basic');
    expect(config('https://trusted.invalid/other/project.git/info/refs')).not.toContain('Authorization: Basic');
    expect(config(repoUrl)).toContain('http.followredirects false');
  });
});
