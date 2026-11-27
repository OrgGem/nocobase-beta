// SPDX-License-Identifier: Apache-2.0

import simpleGit, { SimpleGit } from 'simple-git';
import { Context } from '@nocobase/actions';
import { createHash } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import { getEffectiveActionParams } from '../repository-access';
import { redactError } from '../utils/redact';
import { getRepoAccount } from '../utils/get-repo-account';
import { assertUrlHasNoUserInfo } from '../utils/url-security';
import {
  dispatchClusterGitInstall,
  readClusterGitStatus,
  type ClusterGitApp,
  type ClusterGitStatus,
} from '../utils/cluster-git';

// Disallow leading `-` to prevent argument-injection (e.g. `--upload-pack=...`)
// when refs are passed as positional args to git.
const REF_PATTERN = /^(?!-)[a-zA-Z0-9._/-]+$/;
const FALLBACK_GIT_PATHS = ['git', '/usr/bin/git', '/usr/local/bin/git', '/bin/git'];
const REPO_LOCK_TTL_MS = 5 * 60 * 1000;

export interface RepoLockManager {
  runExclusive<T>(key: string, fn: () => Promise<T>, ttl?: number): Promise<T>;
}

// Per-repo in-process mutex paired with app.lockManager (when available) for HA clusters
const repoLocks = new Map<string, Promise<void>>();
let cachedGitBinary: { envValue: string; binary: string } | null = null;

interface GitActionParams {
  repositoryId?: number | string;
  file?: string;
  commitHash?: string;
  compareHash?: string;
  maxCount?: number | string;
  skip?: number | string;
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

export async function withRepoLock<T>(
  localPath: string,
  fn: () => Promise<T>,
  lockManager?: RepoLockManager,
): Promise<T> {
  const runLocal = async () => {
    const lock = acquireLock(localPath);
    await lock.promise;
    try {
      return await fn();
    } finally {
      lock.release();
    }
  };
  if (lockManager?.runExclusive) {
    const lockKey = `git-repo:${createHash('sha256').update(localPath).digest('hex')}`;
    return lockManager.runExclusive(lockKey, runLocal, REPO_LOCK_TTL_MS);
  }
  return runLocal();
}

export function validateRepoRelativePath(rawPath: string, label = 'file path'): string {
  if (rawPath.includes('\0')) {
    throw new Error(`Invalid ${label}`);
  }
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

async function runAuthenticatedGitUnlocked<T>(
  git: ReturnType<typeof simpleGit>,
  repoUrl: string,
  pat: string,
  fn: () => Promise<T>,
  username?: string,
  remoteName = 'origin',
): Promise<T> {
  try {
    git.env(credentialEnvironment(repoUrl, pat, username));
    // Persist only the clean URL when it differs from .git/config to avoid unnecessary lock contention across HA nodes.
    const currentUrl =
      typeof git.raw === 'function'
        ? (await git.raw(['config', '--get', `remote.${remoteName}.url`]).catch(() => '')).trim()
        : '';
    if (currentUrl !== repoUrl) {
      await git.remote(['set-url', remoteName, repoUrl]);
    }
    return await fn();
  } catch (error) {
    throw redactGitCredentialError(error, pat, username);
  } finally {
    git.env(gitProcessEnvironment());
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
  lockManager?: RepoLockManager,
): Promise<T> {
  validateRepoUrl(repoUrl);
  return withRepoLock(
    localPath,
    () => runAuthenticatedGitUnlocked(git, repoUrl, pat, fn, username, remoteName),
    lockManager,
  );
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

function configuredGitBinary(): string {
  return (process.env.GIT_BINARY_PATH || process.env.GIT_EXECUTABLE || '').trim();
}

function canExecuteGit(binary: string): boolean {
  if (path.isAbsolute(binary) && !fs.existsSync(binary)) {
    return false;
  }
  const check = spawnSync(binary, ['--version'], { stdio: 'ignore' });
  return !check.error && check.status === 0;
}

export function resolveGitBinary(): string | null {
  const configured = configuredGitBinary();
  if (
    cachedGitBinary &&
    cachedGitBinary.envValue === configured &&
    (!path.isAbsolute(cachedGitBinary.binary) || fs.existsSync(cachedGitBinary.binary)) &&
    canExecuteGit(cachedGitBinary.binary)
  ) {
    return cachedGitBinary.binary;
  }
  cachedGitBinary = null;

  const candidates = configured ? [configured] : FALLBACK_GIT_PATHS;
  for (const candidate of candidates) {
    if (canExecuteGit(candidate)) {
      cachedGitBinary = { envValue: configured, binary: candidate };
      return candidate;
    }
  }
  return null;
}

export function resetGitBinaryCacheForTests(): void {
  cachedGitBinary = null;
}

export function isGitAvailable(): boolean {
  return resolveGitBinary() !== null;
}

export function getGitMissingMessage(clusterStatus?: ClusterGitStatus): string {
  const binary = configuredGitBinary() || 'git';
  if (clusterStatus?.available && clusterStatus.status === 'running') {
    return `Git executable "${binary}" is currently being installed via Cluster Manager. Please wait a moment and retry.`;
  }
  if (clusterStatus?.available) {
    return `Git executable "${binary}" was not found on the server. Install git via Cluster Manager (Package Installer), or set GIT_BINARY_PATH to the absolute git binary path.`;
  }
  return `Git executable "${binary}" was not found on the server. Install git in the app/worker container, or set GIT_BINARY_PATH to the absolute git binary path.`;
}

export async function assertGitAvailable(ctx: Context): Promise<string> {
  const binary = resolveGitBinary();
  if (binary) return binary;

  const app = (ctx as Context & { app?: ClusterGitApp }).app;
  const clusterStatus = await readClusterGitStatus(app).catch(() => undefined);
  if (clusterStatus?.available && clusterStatus.gitConfigured && clusterStatus.previouslyInitialized) {
    dispatchClusterGitInstall(app).catch((err) => {
      app?.log?.warn?.('plugin-git-manager: background git restore via Cluster Manager failed', err);
    });
    const refreshedStatus: ClusterGitStatus = { ...clusterStatus, status: 'running' };
    return ctx.throw(503, getGitMissingMessage(refreshedStatus));
  }
  return ctx.throw(503, getGitMissingMessage(clusterStatus));
}

export async function assertLocalGitReady(localPath: string, app?: ClusterGitApp): Promise<SimpleGit> {
  if (!fs.existsSync(localPath)) {
    const missingDirError = Object.assign(
      new Error('Repository directory does not exist. Please clone the repository first.'),
      { status: 400 },
    );
    throw missingDirError;
  }
  const binary = resolveGitBinary();
  if (!binary) {
    const clusterStatus = await readClusterGitStatus(app).catch(() => undefined);
    if (clusterStatus?.available && clusterStatus.gitConfigured && clusterStatus.previouslyInitialized) {
      dispatchClusterGitInstall(app).catch((err) => {
        app?.log?.warn?.('plugin-git-manager: background git restore via Cluster Manager failed', err);
      });
    }
    throw Object.assign(new Error(getGitMissingMessage(clusterStatus)), { status: 503 });
  }
  return createGit(localPath);
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
    binary: getGitBinaryPath(),
    unsafe: { allowUnsafeConfigEnvCount: true, allowUnsafeCredentialHelper: true },
  }).env(gitProcessEnvironment());
}

export function getGitBinaryPath(): string {
  return resolveGitBinary() || configuredGitBinary() || 'git';
}

export async function getGit(ctx: Context, localPath: string): Promise<SimpleGit> {
  if (!fs.existsSync(localPath)) {
    ctx.throw(400, 'Repository directory does not exist. Please clone the repository first.');
  }
  await assertGitAvailable(ctx);
  return createGit(localPath);
}

export async function runtimeStatus(ctx: Context, next: () => Promise<void>) {
  const binary = resolveGitBinary();
  const app = (ctx as Context & { app?: ClusterGitApp }).app;
  const clusterStatus = await readClusterGitStatus(app);
  if (!binary && clusterStatus.available && clusterStatus.gitConfigured && clusterStatus.previouslyInitialized) {
    const restore = await dispatchClusterGitInstall(app).catch(() => ({ dispatched: false }));
    if (restore.dispatched) {
      clusterStatus.status = 'running';
    }
  }
  ctx.body = {
    success: true,
    data: {
      gitAvailable: binary !== null,
      gitBinary: binary || configuredGitBinary() || 'git',
      clusterManager: {
        available: clusterStatus.available,
        gitConfigured: clusterStatus.gitConfigured,
        status: clusterStatus.status,
        progressPercent: clusterStatus.progressPercent,
      },
    },
  };
  await next();
}

export async function installGit(ctx: Context, next: () => Promise<void>) {
  const binary = resolveGitBinary();
  if (binary) {
    ctx.body = { success: true, data: { alreadyInstalled: true, gitBinary: binary } };
    await next();
    return;
  }
  const app = (ctx as Context & { app?: ClusterGitApp }).app;
  const result = await dispatchClusterGitInstall(app, { ensureGitInConfig: true });
  if (!result.dispatched && result.reason !== 'Cluster package installation is already running') {
    ctx.throw(400, result.reason || 'Unable to dispatch git installation via Cluster Manager');
  }
  ctx.body = { success: true, data: { dispatched: true } };
  await next();
}

export async function getRepo(ctx: Context, requestedRepositoryId?: number | string) {
  const repositoryId = requestedRepositoryId ?? getGitActionParams(ctx).repositoryId;
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
  await assertGitAvailable(ctx);

  const app = (ctx as Context & { app?: { lockManager?: RepoLockManager } }).app;
  await withRepoLock(
    localPath,
    async () => {
      if (fs.existsSync(localPath)) {
        const entries = fs.readdirSync(localPath);
        if (entries.length > 0) {
          if (fs.existsSync(path.join(localPath, '.git'))) {
            const existingGit = createGit(localPath);
            const existingOrigin = (
              await existingGit.raw(['config', '--get', 'remote.origin.url']).catch(() => '')
            ).trim();
            if (existingOrigin === repoUrl) {
              await runAuthenticatedGitUnlocked(existingGit, repoUrl, pat, () => existingGit.fetch(), username);
              await ctx.db.getRepository('gitRepositories').update({
                filterByTk: repo.get('id'),
                values: { status: 'connected' },
              });
              ctx.body = { success: true, message: 'Repository reconnected successfully' };
              return;
            }
          }
          ctx.throw(400, 'Directory already exists. Remove it before cloning again.');
        }
      } else if (!fs.existsSync(path.dirname(localPath))) {
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
      }

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
        if (isMissingGitError(err) && !isGitAvailable()) {
          const clusterStatus = await readClusterGitStatus(app as ClusterGitApp).catch(() => undefined);
          ctx.throw(503, getGitMissingMessage(clusterStatus));
        }
        throw redactGitCredentialError(err, pat, username);
      }
    },
    app?.lockManager,
  );
  await next();
}

export async function pull(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const repoUrl = ((repo.get('repoUrl') as string) || '').trim();

  const account = await getRepoAccount(ctx.db, repo);
  if (!account) return ctx.throw(400, 'Repository has no Git account configured. Please assign a Git account first.');
  const { pat, username } = account;

  const git = await getGit(ctx, localPath);
  const lockManager = (ctx as Context & { app?: { lockManager?: RepoLockManager } }).app?.lockManager;
  const result = await withAuth(git, localPath, repoUrl, pat, () => git.pull(), username, 'origin', lockManager);

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

  const git = await getGit(ctx, localPath);
  const lockManager = (ctx as Context & { app?: { lockManager?: RepoLockManager } }).app?.lockManager;
  const result = await withAuth(git, localPath, repoUrl, pat, () => git.push(), username, 'origin', lockManager);

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

  const git = await getGit(ctx, localPath);
  const lockManager = (ctx as Context & { app?: { lockManager?: RepoLockManager } }).app?.lockManager;
  const result = await withAuth(git, localPath, repoUrl, pat, () => git.fetch(), username, 'origin', lockManager);

  ctx.body = { success: true, data: result };
  await next();
}

export async function diff(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { file, commitHash, compareHash } = getGitActionParams(ctx);

  const git = await getGit(ctx, localPath);
  const args: string[] = [];
  if (commitHash && compareHash) {
    args.push(validateRef(commitHash), validateRef(compareHash));
  } else if (commitHash) {
    args.push(validateRef(commitHash) + '^', validateRef(commitHash));
  }
  if (file) {
    let safeFile = '';
    try {
      safeFile = validateRepoRelativePath(file, 'file path');
    } catch {
      ctx.throw(400, 'Invalid file path');
    }
    args.push('--', safeFile);
  }

  const result = await git.diff(args);
  ctx.body = { success: true, data: result };
  await next();
}

export async function status(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const git = await getGit(ctx, localPath);
  const result = await git.status();
  ctx.body = { success: true, data: result };
  await next();
}

export async function log(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { maxCount = 50, file, branch, skip } = getGitActionParams(ctx);

  const parsed = Number.parseInt(String(maxCount), 10);
  const boundedMaxCount = Math.min(Math.max(parsed || 50, 1), 500);
  let safeFile: string | undefined;
  if (file) {
    try {
      safeFile = validateRepoRelativePath(file, 'file path');
    } catch {
      ctx.throw(400, 'Invalid file path');
    }
  }

  const args: string[] = [];
  if (branch) args.push(validateBranch(branch));
  if (skip !== undefined) {
    const parsedSkip = Number(skip);
    if (!Number.isSafeInteger(parsedSkip) || parsedSkip < 0 || parsedSkip > 1000000) {
      ctx.throw(400, 'Invalid history offset');
    }
    args.push(`--skip=${parsedSkip}`);
  }
  const git = await getGit(ctx, localPath);
  const result =
    args.length || safeFile
      ? await git.log([...args, `--max-count=${boundedMaxCount}`, ...(safeFile ? ['--follow', '--', safeFile] : [])])
      : await git.log({ maxCount: boundedMaxCount });
  ctx.body = { success: true, data: result };
  await next();
}

export async function branches(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const git = await getGit(ctx, localPath);
  const result = await git.branch();
  ctx.body = { success: true, data: result };
  await next();
}

export async function checkout(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { branch } = getGitActionParams(ctx);
  if (!branch) ctx.throw(400, 'branch is required');
  validateBranch(branch);
  const git = await getGit(ctx, localPath);
  const lockManager = (ctx as Context & { app?: { lockManager?: RepoLockManager } }).app?.lockManager;
  await withRepoLock(localPath, () => git.checkout(branch), lockManager);
  ctx.body = { success: true, message: `Switched to branch ${branch}` };
  await next();
}

export async function fileTree(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { ref = 'HEAD', treePath = '', recursive } = getGitActionParams(ctx);

  const git = await getGit(ctx, localPath);
  validateRef(ref);
  let safeTreePath = '';
  if (treePath) {
    try {
      safeTreePath = validateRepoRelativePath(treePath, 'tree path');
    } catch {
      ctx.throw(400, 'Invalid tree path');
    }
  }

  const detailArgs = ['-c', 'core.quotePath=false', 'ls-tree', '-l'];
  if (recursive === true || recursive === 'true') detailArgs.push('-r');
  detailArgs.push(ref, '--');
  if (safeTreePath) detailArgs.push(`${safeTreePath}/`);
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
  let safeFilePath = '';
  try {
    safeFilePath = validateRepoRelativePath(filePath, 'file path');
  } catch {
    ctx.throw(400, 'Invalid file path');
  }

  validateRef(ref);
  const git = await getGit(ctx, localPath);
  const content = await git.raw(['-c', 'core.quotePath=false', 'show', `${ref}:${safeFilePath}`]);
  ctx.body = { success: true, data: { content, filePath: safeFilePath, ref } };
  await next();
}

export async function commitDetail(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { commitHash } = getGitActionParams(ctx);

  if (!commitHash) {
    ctx.throw(400, 'commitHash is required');
  }

  const git = await getGit(ctx, localPath);
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

async function readLimitedGitOutput(localPath: string, args: string[], maxBytes: number) {
  return new Promise<{ text: string; truncated: boolean }>((resolve, reject) => {
    const child = spawn(getGitBinaryPath(), args, {
      cwd: localPath,
      env: gitProcessEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = maxBytes - size;
      if (remaining > 0) {
        const data = chunk.subarray(0, remaining);
        chunks.push(data);
        size += data.length;
      }
      if (chunk.length > remaining) {
        truncated = true;
        child.kill();
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !truncated) {
        reject(new Error('Unable to read commit diff'));
        return;
      }
      const text = Buffer.concat(chunks)
        .toString('utf8')
        .replace(/\uFFFD$/, '');
      resolve({ text, truncated });
    });
  });
}

/** Build a bounded commit context, comparing merge commits with their first parent. */
export async function readChatCommit(
  ctx: Context,
  commitHash: string,
  maxFiles: number,
  maxBytes: number,
  repositoryId?: number | string,
) {
  if (!/^[a-f\d]{4,64}$/i.test(commitHash)) ctx.throw(400, 'Invalid commit hash');
  const repo = await getRepo(ctx, repositoryId);
  const localPath = validateLocalPath(repo.get('localPath'));
  const git = await getGit(ctx, localPath);
  const hash = (await git.raw(['rev-parse', '--verify', `${commitHash}^{commit}`])).trim();
  const [metadata, parentLine] = await Promise.all([
    git.raw(['show', '-s', '--format=%H%x00%an%x00%aI%x00%s%x00%b', hash]),
    git.raw(['rev-list', '--parents', '-n', '1', hash]),
  ]);
  const [, author, date, subject, body] = metadata.split('\0');
  const parent = parentLine.trim().split(/\s+/)[1];
  const namesArgs = parent
    ? ['diff', '--name-status', '-z', '-M', parent, hash, '--']
    : ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '-M', hash, '--'];
  const tokens = (await git.raw(namesArgs)).split('\0');
  const files: Array<{ oldPath: string; newPath: string; status: string }> = [];
  for (let index = 0; index < tokens.length && tokens[index]; ) {
    const status = tokens[index++];
    const oldPath = tokens[index++];
    const newPath = /^[RC]/.test(status) ? tokens[index++] : oldPath;
    if (!oldPath || !newPath) break;
    files.push({ oldPath, newPath, status });
  }
  const selectedFiles = files.slice(0, maxFiles);
  const paths = Array.from(new Set(selectedFiles.flatMap((file) => [file.oldPath, file.newPath]))).map(
    (file) => `:(literal)${file}`,
  );
  const patchArgs = parent
    ? ['diff', '--no-ext-diff', '--no-textconv', '--no-color', parent, hash, '--', ...paths]
    : ['show', '--format=', '--no-ext-diff', '--no-textconv', '--no-color', hash, '--', ...paths];
  const patch = paths.length
    ? await readLimitedGitOutput(localPath, patchArgs, maxBytes)
    : { text: '', truncated: false };
  const limitations: string[] = [];
  if (files.length > maxFiles) limitations.push('Additional changed files were omitted.');
  if (patch.truncated) limitations.push('The diff was truncated to the configured limit.');
  if (/^Binary files .* differ$|^GIT binary patch$/m.test(patch.text)) {
    limitations.push('Binary file contents are not included in the diff.');
  }
  return {
    commitSha: hash,
    author,
    date,
    subject,
    body: body?.trim(),
    files: selectedFiles,
    diff: patch.text,
    truncated: patch.truncated || files.length > maxFiles,
    limitations,
  };
}
