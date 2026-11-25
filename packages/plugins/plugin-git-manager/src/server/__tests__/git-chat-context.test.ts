// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Context } from '@nocobase/actions';
import { log, readChatCommit } from '../actions/git-actions';

describe('Git chat commit context', () => {
  let fixture: string;
  let repoPath: string;
  const previousBasePath = process.env.GIT_REPOS_BASE_PATH;

  const runGit = (args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();

  const commit = (message: string) => {
    runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '-A']);
    runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', message]);
    return runGit(['rev-parse', 'HEAD']);
  };

  const createContext = (params: Record<string, unknown> = {}) => {
    const repository = { get: (field: string) => (field === 'localPath' ? 'repository' : undefined) };
    const context = {
      action: { params: { repositoryId: 1, ...params } },
      db: {
        getRepository: vi.fn(() => ({ findOne: vi.fn().mockResolvedValue(repository) })),
      },
      throw: (status: number, message: string): never => {
        throw Object.assign(new Error(message), { status });
      },
      body: undefined as unknown,
    };
    return context as unknown as Context & { body: unknown };
  };

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'git-chat-context-'));
    repoPath = join(fixture, 'repository');
    mkdirSync(repoPath);
    process.env.GIT_REPOS_BASE_PATH = fixture;
    execFileSync('git', ['init', '--initial-branch=main', repoPath], { stdio: 'ignore' });
  });

  afterEach(() => {
    if (previousBasePath === undefined) delete process.env.GIT_REPOS_BASE_PATH;
    else process.env.GIT_REPOS_BASE_PATH = previousBasePath;
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it('reads a root commit and returns only the bounded changed file context', async () => {
    writeFileSync(join(repoPath, 'root.txt'), 'root content\n');
    const rootCommit = commit('Initial commit');

    const result = await readChatCommit(createContext(), rootCommit, 50, 1024);

    expect(result.commitSha).toBe(rootCommit);
    expect(result.subject).toBe('Initial commit');
    expect(result.files).toEqual([{ oldPath: 'root.txt', newPath: 'root.txt', status: 'A' }]);
    expect(result.diff).toContain('+root content');
    expect(result.truncated).toBe(false);
  });

  it('reads history from the selected branch and applies the requested offset', async () => {
    writeFileSync(join(repoPath, 'root.txt'), 'root\n');
    commit('root');
    writeFileSync(join(repoPath, 'main.txt'), 'main\n');
    commit('main change');
    runGit(['checkout', '-b', 'feature/chat-context']);
    writeFileSync(join(repoPath, 'feature-one.txt'), 'first\n');
    const firstFeatureCommit = commit('first feature change');
    writeFileSync(join(repoPath, 'feature-two.txt'), 'second\n');
    commit('second feature change');

    const context = createContext({ branch: 'feature/chat-context', skip: 1, maxCount: 1 });
    await log(context, vi.fn().mockResolvedValue(undefined));

    const body = context.body as { data: { all: Array<{ hash: string }> } };
    expect(body.data.all).toHaveLength(1);
    expect(body.data.all[0].hash).toBe(firstFeatureCommit);
  });

  it('compares merge commits with their first parent', async () => {
    writeFileSync(join(repoPath, 'root.txt'), 'root\n');
    commit('root');
    runGit(['checkout', '-b', 'feature']);
    writeFileSync(join(repoPath, 'feature.txt'), 'feature change\n');
    commit('feature change');
    runGit(['checkout', 'main']);
    writeFileSync(join(repoPath, 'main-only.txt'), 'main change\n');
    commit('main change');
    runGit(['merge', '--no-ff', 'feature', '-m', 'merge feature']);
    const mergeCommit = runGit(['rev-parse', 'HEAD']);

    const result = await readChatCommit(createContext(), mergeCommit, 50, 2048);

    expect(result.subject).toBe('merge feature');
    expect(result.files.map((file) => file.newPath)).toEqual(['feature.txt']);
    expect(result.diff).toContain('+feature change');
    expect(result.diff).not.toContain('main-only.txt');
  });

  it('lists binary changes without adding binary contents to the diff', async () => {
    writeFileSync(join(repoPath, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
    const binaryCommit = commit('Add binary file');

    const result = await readChatCommit(createContext(), binaryCommit, 50, 2048);

    expect(result.files.map((file) => file.newPath)).toEqual(['binary.bin']);
    expect(result.diff).not.toContain('GIT binary patch');
    expect(result.limitations).toContain('Binary file contents are not included in the diff.');
  });

  it('preserves both names for a detected rename', async () => {
    writeFileSync(join(repoPath, 'before.txt'), 'same contents\n');
    commit('Add file');
    renameSync(join(repoPath, 'before.txt'), join(repoPath, 'after.txt'));
    const renameCommit = commit('Rename file');

    const result = await readChatCommit(createContext(), renameCommit, 50, 2048);

    expect(result.files).toEqual([{ oldPath: 'before.txt', newPath: 'after.txt', status: 'R100' }]);
  });

  it('truncates UTF-8 diffs at the byte limit without exceeding it', async () => {
    writeFileSync(join(repoPath, 'unicode.txt'), `${'café 🙂\n'.repeat(80)}`);
    const unicodeCommit = commit('Add unicode content');
    const byteLimit = 280;

    const result = await readChatCommit(createContext(), unicodeCommit, 50, byteLimit);

    expect(Buffer.byteLength(result.diff, 'utf8')).toBeLessThanOrEqual(byteLimit);
    expect(result.truncated).toBe(true);
    expect(result.limitations).toContain('The diff was truncated to the configured limit.');
    expect(result.diff).not.toMatch(/\uFFFD$/);
  });
});
