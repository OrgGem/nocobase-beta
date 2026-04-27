import simpleGit, { SimpleGit } from 'simple-git';
import { Context } from '@nocobase/actions';
import * as path from 'path';
import * as fs from 'fs';

const REF_PATTERN = /^[a-zA-Z0-9._\-\/]+$/;

// Per-repo mutex to prevent PAT race conditions in withAuth
const repoLocks = new Map<string, Promise<any>>();

function acquireLock(key: string): { promise: Promise<void>; release: () => void } {
  const prev = repoLocks.get(key) || Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const promise = prev.then(() => {});
  repoLocks.set(key, next);
  return { promise, release: release! };
}

function validateRef(ref: string): string {
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`Invalid ref: ${ref}`);
  }
  return ref;
}

function validateBranch(branch: string): string {
  if (!branch || !REF_PATTERN.test(branch)) {
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

async function withAuth(git: ReturnType<typeof simpleGit>, repoUrl: string, pat: string, fn: () => Promise<any>) {
  const lockKey = repoUrl;
  const lock = acquireLock(lockKey);
  await lock.promise;
  const authUrl = getAuthUrl(repoUrl, pat);
  await git.remote(['set-url', 'origin', authUrl]);
  try {
    return await fn();
  } finally {
    await git.remote(['set-url', 'origin', repoUrl]);
    lock.release();
  }
}

function getAuthUrl(repoUrl: string, pat: string): string {
  const url = new URL(repoUrl);
  url.username = 'oauth2';
  url.password = pat;
  return url.toString();
}

function getGit(localPath: string): SimpleGit {
  return simpleGit(localPath);
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
function validateLocalPath(localPath: string): string {
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
  const repoUrl = repo.get('repoUrl') as string;
  const pat = repo.get('pat') as string;

  validateRepoUrl(repoUrl);

  // Check if directory already exists
  if (fs.existsSync(localPath)) {
    ctx.throw(400, 'Directory already exists. Remove it before cloning again.');
  }

  if (!fs.existsSync(path.dirname(localPath))) {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
  }

  const authUrl = getAuthUrl(repoUrl, pat);
  try {
    await simpleGit().clone(authUrl, localPath, ['--branch', repo.get('defaultBranch') || 'main']);
    // Remove PAT from the cloned repo's remote URL
    await simpleGit(localPath).remote(['set-url', 'origin', repoUrl]);
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
    throw err;
  }
  await next();
}

export async function pull(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const pat = repo.get('pat') as string;
  const repoUrl = repo.get('repoUrl') as string;

  const git = getGit(localPath);
  const result = await withAuth(git, repoUrl, pat, () => git.pull());

  ctx.body = { success: true, data: result };
  await next();
}

export async function push(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const pat = repo.get('pat') as string;
  const repoUrl = repo.get('repoUrl') as string;

  const git = getGit(localPath);
  const result = await withAuth(git, repoUrl, pat, () => git.push());

  ctx.body = { success: true, data: result };
  await next();
}

export async function fetch(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const pat = repo.get('pat') as string;
  const repoUrl = repo.get('repoUrl') as string;

  const git = getGit(localPath);
  const result = await withAuth(git, repoUrl, pat, () => git.fetch());

  ctx.body = { success: true, data: result };
  await next();
}

export async function diff(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { file, commitHash, compareHash } = ctx.action.params;

  const git = getGit(localPath);
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
  const result = await getGit(localPath).status();
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

  const result = await getGit(localPath).log(options);
  ctx.body = { success: true, data: result };
  await next();
}

export async function branches(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const result = await getGit(localPath).branch();
  ctx.body = { success: true, data: result };
  await next();
}

export async function checkout(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { branch } = ctx.action.params;
  validateBranch(branch);
  await getGit(localPath).checkout(branch);
  ctx.body = { success: true, message: `Switched to branch ${branch}` };
  await next();
}

export async function fileTree(ctx: Context, next: () => Promise<void>) {
  const repo = await getRepo(ctx);
  const localPath = validateLocalPath(repo.get('localPath'));
  const { ref = 'HEAD', treePath = '' } = ctx.action.params;

  const git = getGit(localPath);
  validateRef(ref);
  if (treePath && treePath.includes('..')) {
    ctx.throw(400, 'Invalid tree path');
  }

  const detailArgs = ['ls-tree', '-l', ref];
  if (treePath) detailArgs.push(treePath + '/');
  const detailedResult = await git.raw(detailArgs);
  const items = detailedResult.trim().split('\n').filter(Boolean).map((line) => {
    // format: <mode> <type> <hash> <size>\t<name>
    const match = line.match(/^(\d+)\s+(blob|tree)\s+([a-f0-9]+)\s+(-|\d+)\t(.+)$/);
    if (!match) return null;
    const fullPath = match[5];
    // Extract just the filename from the full path when using treePath prefix
    const name = fullPath.includes('/') ? fullPath.split('/').pop()! : fullPath;
    return {
      mode: match[1],
      type: match[2] as 'blob' | 'tree',
      hash: match[3],
      size: match[4] === '-' ? 0 : parseInt(match[4], 10),
      name,
      path: treePath ? `${treePath}/${name}` : name,
    };
  }).filter(Boolean);

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
  const git = getGit(localPath);
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

  const git = getGit(localPath);
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
  const files = diffResult.trim().split('\n').filter(Boolean).map((line) => {
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
