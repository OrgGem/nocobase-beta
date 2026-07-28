import simpleGit, { SimpleGit } from 'simple-git';
import { Context } from '@nocobase/actions';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { redactPat, redactError } from '../utils/redact';
import { getRepoAccount } from '../utils/get-repo-account';

// Disallow leading `-` to prevent argument-injection (e.g. `--upload-pack=...`)
// when refs are passed as positional args to git.
const REF_PATTERN = /^(?!-)[a-zA-Z0-9._/-]+$/;

// Per-repo mutex to prevent PAT race conditions in withAuth
const repoLocks = new Map<string, Promise<any>>();
const GIT_BINARY = process.env.GIT_BINARY_PATH || process.env.GIT_EXECUTABLE || 'git';
let gitAvailabilityChecked = false;

export function acquireLock(key: string): { promise: Promise<void>; release: () => void } {
  const prev = repoLocks.get(key) || Promise.resolve();
  let release = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const promise = prev.then(() => {});
  repoLocks.set(key, next);
  return { promise, release };
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

function validateRepoUrl(repoUrl: string): void {
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
  // Lock by local working tree — that's what `git.remote('set-url', ...)`
  // mutates. Two repo records sharing a `repoUrl` but cloned to different
  // paths can run in parallel safely; conversely, two repos pointed at the
  // same `localPath` (config error) must NOT run concurrent set-url's.
  const lockKey = localPath;
  const lock = acquireLock(lockKey);
  await lock.promise;
  const authUrl = getAuthUrl(repoUrl, pat, username);
  await git.remote(['set-url', remoteName, authUrl]);
  try {
    return await fn();
  } catch (err) {
    // simple-git often echoes the authenticated URL in stderr — scrub before re-throw
    throw redactError(err);
  } finally {
    // H-2 fix: guard PAT cleanup — if reset fails, the PAT-embedded URL persists on disk
    try {
      await git.remote(['set-url', remoteName, repoUrl]);
    } catch (cleanupErr) {
      // Critical: PAT may be persisted in .git/config — attempt one more cleanup
      try {
        await git.remote(['set-url', remoteName, repoUrl]);
      } catch {
        // Log but don't throw — the original operation already completed
        console.error(
          `[plugin-git-manager] CRITICAL: failed to remove PAT from remote URL for ${redactPat(repoUrl)}. ` +
            `Manual cleanup of .git/config may be required.`,
          redactError(cleanupErr),
        );
      }
    }
    lock.release();
  }
}

function getAuthUrl(repoUrl: string, pat: string, username?: string): string {
  const url = new URL(repoUrl.trim());
  url.username = (username || 'oauth2').trim();
  url.password = pat.trim();
  return url.toString();
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

function isMissingGitError(error: any) {
  const message = error?.message || String(error);
  return error?.code === 'ENOENT' || /spawn .*git.*ENOENT/i.test(message);
}

export function createGit(baseDir?: string): SimpleGit {
  return simpleGit({ baseDir, binary: GIT_BINARY } as any);
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

async function getRepo(ctx: Context) {
  const { repositoryId } = ctx.action.params;
  const repo = await ctx.db.getRepository('gitRepositories').findOne({
    filterByTk: repositoryId,
  });
  if (!repo) {
    ctx.throw(404, 'Repository not found');
  }
  return repo;
}

// Validate localPath to prevent path traversal
export function validateLocalPath(localPath: string): string {
  const basePath = process.env.GIT_REPOS_BASE_PATH || path.join(process.cwd(), 'storage', 'git-repos');
  const resolved = path.resolve(basePath, localPath);

  // Ensure the resolved path is strictly inside the basePath.
  // We add path.sep to prevent partial matches like /storage/git-repo-hack matching /storage/git-repo
  const strictBasePath = path.resolve(basePath) + path.sep;

  if (!resolved.startsWith(strictBasePath) && resolved !== path.resolve(basePath)) {
    throw new Error('Invalid local path: path traversal detected or path is outside the allowed base directory');
  }
  return resolved;
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

  const authUrl = getAuthUrl(repoUrl, pat, username);
  assertGitAvailable(ctx);
  try {
    await createGit().clone(authUrl, localPath, ['--branch', defaultBranch]);
    // Remove PAT from the cloned repo's remote URL
    await createGit(localPath).remote(['set-url', 'origin', repoUrl]);
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
    throw redactError(err);
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
  const { file, commitHash, compareHash } = ctx.action.params;

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
  const { maxCount = 50, file } = ctx.action.params;

  const parsed = parseInt(maxCount, 10);
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
  const { branch } = ctx.action.params;
  validateBranch(branch);
  await getGit(ctx, localPath).checkout(branch);
  ctx.body = { success: true, message: `Switched to branch ${branch}` };
  await next();
}

export async function fileTree(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { ref = 'HEAD', treePath = '', recursive } = ctx.action.params;

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
  const { ref = 'HEAD', filePath } = ctx.action.params;

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
  const { commitHash } = ctx.action.params;

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
