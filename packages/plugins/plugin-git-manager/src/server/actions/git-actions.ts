/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import simpleGit, { SimpleGit } from 'simple-git';
import { Context } from '@nocobase/actions';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { getEffectiveActionParams } from '../repository-access';
import { redactError } from '../utils/redact';
import { getRepoAccount } from '../utils/get-repo-account';
import { assertUrlHasNoUserInfo } from '../utils/url-security';

// Disallow leading `-` to prevent argument-injection (e.g. `--upload-pack=...`)
// when refs are passed as positional args to git.
const REF_PATTERN = /^(?!-)[a-zA-Z0-9._/-]+$/;

// Per-repo mutex to prevent PAT race conditions in withAuth
const repoLocks = new Map<string, Promise<void>>();
const GIT_BINARY = process.env.GIT_BINARY_PATH || process.env.GIT_EXECUTABLE || 'git';
let gitAvailabilityChecked = false;

interface GitActionParams {
  repositoryId?: number | string;
  file?: string;
  commitHash?: string;
  compareHash?: string;
  maxCount?: number | string;
  branch?: string;
  ref?: string;
  treePath?: string;
  recursive?: boolean | string;
  filePath?: string;
}

function getGitActionParams(ctx: Context): GitActionParams {
  return getEffectiveActionParams(ctx) as GitActionParams;
}

export function acquireLock(key: string): { promise: Promise<void>; release: () => void } {
  const prev = repoLocks.get(key) || Promise.resolve();
  let release = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const promise = prev.then(() => {});
  repoLocks.set(key, next);
  return {
    promise,
    release: () => {
      release();
      if (repoLocks.get(key) === next) repoLocks.delete(key);
    },
  };
}

export function validateRef(ref: string): string {
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`Invalid ref: ${ref}`);
  }
  return ref;
}

export function validateBranch(branch: string): string {
  const segments = branch.split('/');
  if (
    !branch ||
    !REF_PATTERN.test(branch) ||
    branch === '@' ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    segments.some((segment) => segment.startsWith('.') || segment.toLowerCase().endsWith('.lock'))
  ) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  return branch;
}

export function validateRepoUrl(repoUrl: string): void {
  assertUrlHasNoUserInfo(repoUrl);
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new Error('Invalid repository URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS repository URLs are allowed');
  }
}

export async function withAuth<T>(
  git: ReturnType<typeof simpleGit>,
  localPath: string,
  repoUrl: string,
  pat: string,
  fn: () => Promise<T>,
  username?: string,
  remoteName = 'origin',
): Promise<T> {
  validateRepoUrl(repoUrl);
  const lock = acquireLock(localPath);
  await lock.promise;
  try {
    git.env(credentialEnvironment(repoUrl, pat, username));
    // Persist only the clean URL. Authentication is scoped to this URL in the child process environment.
    await git.remote(['set-url', remoteName, repoUrl]);
    return await fn();
  } catch (error) {
    throw redactGitCredentialError(error, pat, username);
  } finally {
    try {
      git.env(gitProcessEnvironment());
    } finally {
      lock.release();
    }
  }
}

function gitProcessEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    // Strip executable/config overrides and trace settings inherited from the server or test runner.
    if (
      (/^GIT_/i.test(key) && !/^GIT_SSL_CA(INFO|PATH)$/i.test(key)) ||
      /^(EDITOR|PAGER|PREFIX|SSH_ASKPASS)$/i.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

export function credentialEnvironment(repoUrl: string, pat: string, username?: string): NodeJS.ProcessEnv {
  validateRepoUrl(repoUrl);
  const authorization = Buffer.from(`${(username || 'oauth2').trim()}:${pat.trim()}`).toString('base64');
  const settings = [
    ['http.extraHeader', ''],
    [`http.${new URL(repoUrl).toString()}.extraHeader`, `Authorization: Basic ${authorization}`],
    ['http.followRedirects', 'false'],
    ['credential.helper', ''],
  ];
  const env: NodeJS.ProcessEnv = {
    ...gitProcessEnvironment(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

function redactGitCredentialError(error: unknown, pat: string, username?: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const authorization = Buffer.from(`${(username || 'oauth2').trim()}:${pat.trim()}`).toString('base64');
  let safeMessage = message;
  for (const secret of [authorization, pat.trim()]) {
    if (secret) safeMessage = safeMessage.split(secret).join('***');
  }
  return redactError(new Error(safeMessage));
}

function getGitMissingMessage() {
  return `Git executable "${GIT_BINARY}" was not found on the server. Install git in the app/worker container, or set GIT_BINARY_PATH to the absolute git binary path.`;
}

function assertGitAvailable(ctx: Context) {
  if (gitAvailabilityChecked) return;

  const check = spawnSync(GIT_BINARY, ['--version'], { stdio: 'ignore' });
  if (check.error || check.status !== 0) {
    ctx.throw(503, getGitMissingMessage());
  }
  gitAvailabilityChecked = true;
}

function isMissingGitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT' || /spawn .*git.*ENOENT/i.test(message);
}

export function createGit(baseDir?: string): SimpleGit {
  // Only plugin-generated environment config and the empty credential helper reset are permitted.
  // All config keys and values come from credentialEnvironment, never from request parameters.
  return simpleGit({
    baseDir,
    binary: GIT_BINARY,
    unsafe: { allowUnsafeConfigEnvCount: true, allowUnsafeCredentialHelper: true },
  }).env(gitProcessEnvironment());
}

export function getGitBinaryPath(): string {
  return GIT_BINARY;
}

function getGit(ctx: Context, localPath: string): SimpleGit {
  if (!fs.existsSync(localPath)) {
    ctx.throw(400, 'Repository directory does not exist. Please clone the repository first.');
  }
  assertGitAvailable(ctx);
  return createGit(localPath);
}

export async function getRepo(ctx: Context) {
  const { repositoryId } = getGitActionParams(ctx);
  const repo = await ctx.db.getRepository('gitRepositories').findOne({
    filterByTk: repositoryId,
  });
  if (!repo) {
    ctx.throw(404, 'Repository not found');
  }
  return repo;
}

// Resolve existing ancestors too, so junctions and symlinks cannot escape through a new clone destination.
function canonicalPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling link must not be treated as an ordinary missing directory.
    try {
      if (fs.lstatSync(value).isSymbolicLink()) throw new Error('Invalid local path');
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
    }
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(canonicalPath(parent), path.basename(value));
  }
}

export function validateLocalPath(localPath: string): string {
  const basePath = path.resolve(process.env.GIT_REPOS_BASE_PATH || path.join(process.cwd(), 'storage', 'git-repos'));
  const resolved = path.resolve(basePath, localPath);
  const base = canonicalPath(basePath);
  const candidate = canonicalPath(resolved);
  for (const [root, target] of [
    [basePath, resolved],
    [base, candidate],
  ]) {
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Invalid local path: path traversal detected or path is outside the allowed base directory');
    }
  }
  return candidate;
}

export async function clone(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const repoUrl = ((repo.get('repoUrl') as string) || '').trim();
  const defaultBranch = ((repo.get('defaultBranch') as string) || 'main').trim() || 'main';

  const account = await getRepoAccount(ctx.db, repo);
  if (!account) return ctx.throw(400, 'Repository has no Git account configured. Please assign a Git account first.');
  const { pat, username } = account;

  validateRepoUrl(repoUrl);
  // Prevent argument-injection through `defaultBranch` (e.g. `--upload-pack=...`)
  validateBranch(defaultBranch);

  // Check if directory already exists
  if (fs.existsSync(localPath)) {
    ctx.throw(400, 'Directory already exists. Remove it before cloning again.');
  }

  if (!fs.existsSync(path.dirname(localPath))) {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
  }

  assertGitAvailable(ctx);
  try {
    await createGit()
      .env(credentialEnvironment(repoUrl, pat, username))
      .clone(repoUrl, localPath, ['--branch', defaultBranch]);
    await ctx.db.getRepository('gitRepositories').update({
      filterByTk: repo.get('id'),
      values: { status: 'connected' },
    });
    ctx.body = { success: true, message: 'Repository cloned successfully' };
  } catch (err) {
    await ctx.db.getRepository('gitRepositories').update({
      filterByTk: repo.get('id'),
      values: { status: 'error' },
    });
    // Redact embedded PAT before the error reaches the client / log
    if (isMissingGitError(err)) {
      ctx.throw(503, getGitMissingMessage());
    }
    throw redactGitCredentialError(err, pat, username);
  }
  await next();
}

export async function pull(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const repoUrl = ((repo.get('repoUrl') as string) || '').trim();

  const account = await getRepoAccount(ctx.db, repo);
  if (!account) return ctx.throw(400, 'Repository has no Git account configured. Please assign a Git account first.');
  const { pat, username } = account;

  const git = getGit(ctx, localPath);
  const result = await withAuth(git, localPath, repoUrl, pat, () => git.pull(), username);

  ctx.body = { success: true, data: result };
  await next();
}

export async function push(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const repoUrl = ((repo.get('repoUrl') as string) || '').trim();

  const account = await getRepoAccount(ctx.db, repo);
  if (!account) return ctx.throw(400, 'Repository has no Git account configured. Please assign a Git account first.');
  const { pat, username } = account;

  const git = getGit(ctx, localPath);
  const result = await withAuth(git, localPath, repoUrl, pat, () => git.push(), username);

  ctx.body = { success: true, data: result };
  await next();
}

export async function fetch(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const repoUrl = ((repo.get('repoUrl') as string) || '').trim();

  const account = await getRepoAccount(ctx.db, repo);
  if (!account) return ctx.throw(400, 'Repository has no Git account configured. Please assign a Git account first.');
  const { pat, username } = account;

  const git = getGit(ctx, localPath);
  const result = await withAuth(git, localPath, repoUrl, pat, () => git.fetch(), username);

  ctx.body = { success: true, data: result };
  await next();
}

export async function diff(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { file, commitHash, compareHash } = getGitActionParams(ctx);

  const git = getGit(ctx, localPath);
  const args: string[] = [];
  if (commitHash && compareHash) {
    args.push(validateRef(commitHash), validateRef(compareHash));
  } else if (commitHash) {
    args.push(validateRef(commitHash) + '^', validateRef(commitHash));
  }
  if (file) {
    if (file.includes('..')) ctx.throw(400, 'Invalid file path');
    args.push('--', file);
  }

  const result = await git.diff(args);
  ctx.body = { success: true, data: result };
  await next();
}

export async function status(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const result = await getGit(ctx, localPath).status();
  ctx.body = { success: true, data: result };
  await next();
}

export async function log(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { maxCount = 50, file } = getGitActionParams(ctx);

  const parsed = Number.parseInt(String(maxCount), 10);
  const options: Record<string, any> = { maxCount: Math.min(Math.max(parsed || 50, 1), 500) };
  if (file) {
    if (file.includes('..')) ctx.throw(400, 'Invalid file path');
    options.file = file;
  }

  const result = await getGit(ctx, localPath).log(options);
  ctx.body = { success: true, data: result };
  await next();
}

export async function branches(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const result = await getGit(ctx, localPath).branch();
  ctx.body = { success: true, data: result };
  await next();
}

export async function checkout(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { branch } = getGitActionParams(ctx);
  if (!branch) ctx.throw(400, 'branch is required');
  validateBranch(branch);
  await getGit(ctx, localPath).checkout(branch);
  ctx.body = { success: true, message: `Switched to branch ${branch}` };
  await next();
}

export async function fileTree(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { ref = 'HEAD', treePath = '', recursive } = getGitActionParams(ctx);

  const git = getGit(ctx, localPath);
  validateRef(ref);
  if (treePath && treePath.includes('..')) {
    ctx.throw(400, 'Invalid tree path');
  }

  const detailArgs = ['ls-tree', '-l'];
  if (recursive === true || recursive === 'true') detailArgs.push('-r');
  detailArgs.push(ref);
  if (treePath) detailArgs.push(treePath + '/');
  const detailedResult = await git.raw(detailArgs);
  const items = detailedResult
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // format: <mode> <type> <hash> <size>\t<name>
      const match = line.match(/^(\d+)\s+(blob|tree)\s+([a-f0-9]+)\s+(-|\d+)\t(.+)$/);
      if (!match) return null;
      const fullPath = match[5];
      // Extract just the filename from the full path when using treePath prefix
      const parts = fullPath.split('/');
      const name = fullPath.includes('/') ? parts[parts.length - 1] : fullPath;
      return {
        mode: match[1],
        type: match[2] as 'blob' | 'tree',
        hash: match[3],
        size: match[4] === '-' ? 0 : parseInt(match[4], 10),
        name,
        path: fullPath,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  // Sort: directories first, then files, both alphabetical
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  ctx.body = { success: true, data: items };
  await next();
}

export async function fileContent(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { ref = 'HEAD', filePath } = getGitActionParams(ctx);

  if (!filePath) {
    ctx.throw(400, 'filePath is required');
  }
  if (filePath.includes('..')) {
    ctx.throw(400, 'Invalid file path');
  }

  validateRef(ref);
  const git = getGit(ctx, localPath);
  const content = await git.show([`${ref}:${filePath}`]);
  ctx.body = { success: true, data: { content, filePath, ref } };
  await next();
}

export async function commitDetail(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { commitHash } = getGitActionParams(ctx);

  if (!commitHash) {
    ctx.throw(400, 'commitHash is required');
  }

  const git = getGit(ctx, localPath);
  validateRef(commitHash);

  // Use %x00 in format string to tell git to output null bytes, avoiding null bytes in args
  const DELIM_ARG = '%x00';
  const DELIM_OUT = '\x00';
  const format = `%H${DELIM_ARG}%an${DELIM_ARG}%ae${DELIM_ARG}%aI${DELIM_ARG}%s${DELIM_ARG}%b`;

  // Run show + diff in parallel for better performance
  const [show, diffResult] = await Promise.all([
    git.show([commitHash, '--stat', `--format=${format}`]),
    git.diff([`${commitHash}^`, commitHash, '--name-status']).catch(() =>
      // Root commit has no parent — use diff-tree --root instead
      git.raw(['diff-tree', '--root', '--name-status', '-r', commitHash]),
    ),
  ]);

  const parts = show.split(DELIM_OUT);
  const files = diffResult
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [statusCode, ...fileParts] = line.split('\t');
      return { status: statusCode, file: fileParts.join('\t') };
    });

  ctx.body = {
    success: true,
    data: {
      hash: parts[0] || '',
      author: parts[1] || '',
      email: parts[2] || '',
      date: parts[3] || '',
      subject: parts[4] || '',
      body: (parts[5] || '').split('\n\n')[0].trim(), // body before --stat output
      files,
      raw: show,
    },
  };
  await next();
}
