/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Database } from '@nocobase/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPinnedReviewSource, resolveReviewSource } from '../review-source';

const projectHead = 'b'.repeat(40);
const projectBase = 'a'.repeat(40);

function record(values: Record<string, unknown>) {
  return { get: (attribute: string) => values[attribute] };
}

describe('pinned Git review source', () => {
  let fixture: string;
  let repositoryPath: string;
  let otherRepositoryPath: string;
  let commitSha: string;
  const originalBase = process.env.GIT_REPOS_BASE_PATH;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'git-review-source-'));
    repositoryPath = join(fixture, 'repository');
    otherRepositoryPath = join(fixture, 'other-repository');
    mkdirSync(repositoryPath);
    mkdirSync(otherRepositoryPath);
    process.env.GIT_REPOS_BASE_PATH = fixture;
    execFileSync('git', ['init', '-b', 'main', repositoryPath], { stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main', otherRepositoryPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'test@example.invalid'], { stdio: 'ignore' });
    execFileSync('git', ['-C', otherRepositoryPath, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    execFileSync('git', ['-C', otherRepositoryPath, 'config', 'user.email', 'test@example.invalid'], {
      stdio: 'ignore',
    });
    writeFileSync(join(repositoryPath, 'reviewed.txt'), 'first revision\n');
    execFileSync('git', ['-C', repositoryPath, 'add', 'reviewed.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repositoryPath, 'commit', '-m', 'first revision'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repositoryPath, 'remote', 'add', 'origin', 'https://gitlab.test/team/project.git'], {
      stdio: 'ignore',
    });
    writeFileSync(join(otherRepositoryPath, 'reviewed.txt'), 'other project revision\n');
    execFileSync('git', ['-C', otherRepositoryPath, 'add', 'reviewed.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', otherRepositoryPath, 'commit', '-m', 'other project revision'], { stdio: 'ignore' });
    execFileSync('git', ['-C', otherRepositoryPath, 'remote', 'add', 'origin', 'https://gitlab.test/team/other.git'], {
      stdio: 'ignore',
    });
    commitSha = execFileSync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBase === undefined) delete process.env.GIT_REPOS_BASE_PATH;
    else process.env.GIT_REPOS_BASE_PATH = originalBase;
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  function createDatabase() {
    const database = {
      getRepository: vi.fn((name: string) => {
        if (name !== 'gitAccounts') throw new Error(`Unexpected repository ${name}`);
        return {
          findOne: async () =>
            record({
              provider: 'gitlab',
              baseUrl: 'https://gitlab.test',
              pat: 'test-only-token',
              username: 'test',
            }),
        };
      }),
    };
    return database as unknown as Database;
  }

  function createRepository(id: number, repoUrl: string, localPath = 'repository') {
    return record({ id, repoUrl, gitAccountId: 1, localPath, defaultBranch: 'main' });
  }

  function mockProject(projectId: number, webUrl = 'https://gitlab.test/team/project') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const isSeparateProject = String(input).includes('team%2Fother');
        const body = isSeparateProject
          ? { id: projectId + 1, web_url: 'https://gitlab.test/team/other' }
          : { id: projectId, web_url: webUrl };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  }

  it('maps repository URL aliases to the provider canonical project identity', async () => {
    mockProject(71);
    const database = createDatabase();
    const aliases = await Promise.all([
      resolveReviewSource(database, createRepository(1, 'https://gitlab.test/team/project.git'), {
        targetType: 'commit',
        commitSha,
      }),
      resolveReviewSource(database, createRepository(2, 'https://gitlab.test/team/project'), {
        targetType: 'commit',
        commitSha,
      }),
    ]);
    const otherCommit = execFileSync('git', ['-C', otherRepositoryPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const separateProject = await resolveReviewSource(
      database,
      createRepository(3, 'https://gitlab.test/team/other', 'other-repository'),
      { targetType: 'commit', commitSha: otherCommit },
    );

    expect(aliases[0].projectKey).toBe(aliases[1].projectKey);
    expect(aliases[0].projectKey).not.toBe(separateProject.projectKey);
    expect(aliases.map((source) => source.headSha)).toEqual([commitSha, commitSha]);
  });

  it('rejects a configured repository whose local checkout origin belongs to another project', async () => {
    mockProject(71);

    await expect(
      resolveReviewSource(
        createDatabase(),
        createRepository(1, 'https://gitlab.test/team/project.git', 'other-repository'),
        { targetType: 'commit', commitSha },
      ),
    ).rejects.toThrow('Checkout origin does not match the configured project');
  });

  it('pins a merge request to its resolved head and base commits', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/merge_requests/9')
        ? { sha: projectHead, diff_refs: { base_sha: projectBase }, source_branch: 'feature/review' }
        : { id: 71, web_url: 'https://gitlab.test/team/project' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const source = await resolveReviewSource(
      createDatabase(),
      createRepository(1, 'https://gitlab.test/team/project.git'),
      {
        targetType: 'mr',
        mrIid: 9,
        headSha: projectHead,
      },
    );

    expect(source).toMatchObject({
      targetType: 'mr',
      mrIid: 9,
      branch: 'feature/review',
      headSha: projectHead,
      baseSha: projectBase,
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      'https://gitlab.test/api/v4/projects/team%2Fproject/merge_requests/9',
    );
  });

  it('rejects a changed merge-request head at admission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const body = url.includes('/merge_requests/9')
          ? { sha: projectHead, diff_refs: { base_sha: projectBase }, source_branch: 'feature/review' }
          : { id: 71, web_url: 'https://gitlab.test/team/project' };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    await expect(
      resolveReviewSource(createDatabase(), createRepository(1, 'https://gitlab.test/team/project.git'), {
        targetType: 'mr',
        mrIid: 9,
        headSha: 'c'.repeat(40),
      }),
    ).rejects.toThrow('Merge request head changed before review admission');
  });

  it('reads an admitted merge request diff at its immutable SHA pair', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/repository/compare')
        ? {
            compare_timeout: false,
            overflow: false,
            diffs: [{ old_path: 'src/action.ts', new_path: 'src/action.ts', diff: '@@ -1 +1 @@\n-old()\n+new()' }],
          }
        : url.includes('/merge_requests/9')
          ? { sha: projectHead, diff_refs: { base_sha: projectBase }, source_branch: 'feature/review' }
          : { id: 71, web_url: 'https://gitlab.test/team/project' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const database = createDatabase();
    const repository = createRepository(1, 'https://gitlab.test/team/project.git');
    const source = await resolveReviewSource(database, repository, {
      targetType: 'mr',
      mrIid: 9,
      headSha: projectHead,
    });

    const diff = await readPinnedReviewSource(database, repository, source);

    expect(diff).toContain('+new()');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      `https://gitlab.test/api/v4/projects/team%2Fproject/repository/compare?from=${projectBase}&to=${projectHead}`,
    );
  });
});
