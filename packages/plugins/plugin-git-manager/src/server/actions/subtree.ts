import { Context } from '@nocobase/actions';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SimpleGit } from 'simple-git';
import { createGit, validateBranch, validateLocalPath, withAuth } from './git-actions';
import { getRepoAccount } from '../utils/get-repo-account';
import { redactError, redactPat } from '../utils/redact';

export type SubtreePolicy = 'fastForward' | 'replace' | 'merge';
export type SubtreeRelationship = 'target-missing' | 'already-up-to-date' | 'fast-forward' | 'diverged';
export const SUBTREE_EXECUTION_MODE = 'app' as const;

interface RecordLike {
  get(attribute: string): unknown;
}

interface SubtreeConfig {
  id: number | string;
  repositoryId: number | string;
  sourceBranch: string;
  sourcePrefix: string;
  sourcePrefixes: string[];
  targetBranch: string;
  remoteName: string;
  enabled: boolean;
}

interface PreviewResult {
  sourceSha: string;
  splitSha: string;
  targetExists: boolean;
  targetSha: string | null;
  relationship: SubtreeRelationship;
  recommendedPolicy: SubtreePolicy;
  availablePolicies: SubtreePolicy[];
}

interface RunParams {
  configId: number | string;
  policy: SubtreePolicy;
  push: boolean;
  expectedTargetSha?: string;
}

function getActionParams(ctx: Context): Record<string, unknown> {
  const requestBody = (ctx as Context & { request?: { body?: Record<string, unknown> } }).request?.body || {};
  return { ...ctx.action.params, ...ctx.action.params?.values, ...requestBody };
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function recordToConfig(record: RecordLike): SubtreeConfig {
  const storedPrefixes = record.get('sourcePrefixes');
  const sourcePrefix = stringValue(record.get('sourcePrefix'));
  return {
    id: record.get('id') as number | string,
    repositoryId: record.get('repositoryId') as number | string,
    sourceBranch: stringValue(record.get('sourceBranch')),
    sourcePrefix,
    sourcePrefixes: validateSubtreePrefixes(Array.isArray(storedPrefixes) ? storedPrefixes : [sourcePrefix]),
    targetBranch: stringValue(record.get('targetBranch')),
    remoteName: stringValue(record.get('remoteName'), 'origin') || 'origin',
    enabled: record.get('enabled') !== false,
  };
}

export function validateSubtreePrefix(prefix: string): string {
  const normalized = prefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error('Source folder must be a non-empty relative path');
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Source folder contains an invalid path segment');
  }
  return normalized;
}

export function validateSubtreePrefixes(prefixes: unknown[]): string[] {
  const normalized = Array.from(new Set(prefixes.map((prefix) => validateSubtreePrefix(stringValue(prefix))))).sort();
  for (const prefix of normalized) {
    if (normalized.some((candidate) => candidate !== prefix && prefix.startsWith(`${candidate}/`))) {
      throw new Error('Source folders cannot contain overlapping parent and child paths');
    }
  }
  return normalized;
}

export function validateRemoteName(remoteName: string): string {
  if (!/^(?!-)[a-zA-Z0-9._-]+$/.test(remoteName)) {
    throw new Error('Invalid Git remote name');
  }
  return remoteName;
}

export function validateSubtreePolicy(policy: unknown): SubtreePolicy {
  if (policy === 'fastForward' || policy === 'replace' || policy === 'merge') return policy;
  throw new Error('Invalid subtree update policy');
}

export function validateSubtreeConfigInput(values: Record<string, unknown>): void {
  const sourceBranch = stringValue(values.sourceBranch);
  const targetBranch = stringValue(values.targetBranch);
  if (sourceBranch) validateBranch(sourceBranch);
  if (targetBranch) validateBranch(targetBranch);
  if (sourceBranch && targetBranch && sourceBranch === targetBranch) {
    throw new Error('Source branch and target branch must be different');
  }
  if (values.sourcePrefixes !== undefined) {
    if (!Array.isArray(values.sourcePrefixes) || values.sourcePrefixes.length === 0) {
      throw new Error('At least one source folder is required');
    }
    validateSubtreePrefixes(values.sourcePrefixes);
  } else if (values.sourcePrefix !== undefined) {
    validateSubtreePrefix(stringValue(values.sourcePrefix));
  }
  if (values.remoteName !== undefined) validateRemoteName(stringValue(values.remoteName));
  if (values.defaultPolicy !== undefined) validateSubtreePolicy(values.defaultPolicy);
}

export function validateRunAgainstPreview(
  policy: SubtreePolicy,
  preview: Pick<PreviewResult, 'relationship' | 'targetSha'>,
  expectedTargetSha?: string,
): void {
  if (policy === 'fastForward' && preview.relationship === 'diverged') {
    throw new Error('Target branch cannot be fast-forwarded to the new subtree commit');
  }
  if (policy === 'replace' && preview.targetSha) {
    if (!expectedTargetSha) throw new Error('Replace policy requires the preview target SHA');
    if (expectedTargetSha !== preview.targetSha) {
      throw new Error('Target branch changed after preview; run preview again');
    }
  }
}

export async function recoverStuckSubtreeRuns(app: {
  db: { getRepository: (name: string) => { update: (options: unknown) => Promise<unknown> } };
}): Promise<void> {
  const finishedAt = new Date();
  const staleBefore = new Date(finishedAt.getTime() - 60 * 60 * 1000);
  await app.db.getRepository('gitSubtreeRuns').update({
    filter: { status: 'running', startedAt: { $lt: staleBefore } },
    values: { status: 'failed', finishedAt, error: 'Subtree run was interrupted by a server restart' },
  });
}

async function resolveOptionalRef(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    return (await git.revparse(['--verify', ref])).trim();
  } catch {
    return null;
  }
}

async function isAncestor(git: SimpleGit, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git.raw(['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function assertCleanWorkingTree(git: SimpleGit): Promise<void> {
  const status = await git.status();
  if (!status.isClean()) throw new Error('Repository working tree must be clean before running a subtree split');
}

async function assertGitBranchFormat(git: SimpleGit, branch: string): Promise<void> {
  try {
    await git.raw(['check-ref-format', '--branch', branch]);
  } catch {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

async function createCombinedSnapshot(git: SimpleGit, sourceSha: string, prefixes: string[]): Promise<string> {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nocobase-git-snapshot-'));
  const indexPath = path.join(temporaryRoot, 'index');
  const repositoryRoot = (await git.revparse(['--show-toplevel'])).trim();
  const indexGit = createGit(repositoryRoot).env('GIT_INDEX_FILE', indexPath);
  try {
    await indexGit.raw(['read-tree', '--empty']);
    for (const prefix of prefixes) {
      const treeSha = (await git.revparse([`${sourceSha}:${prefix}`])).trim();
      await indexGit.raw(['read-tree', `--prefix=${prefix}/`, treeSha]);
    }
    const treeSha = (await indexGit.raw(['write-tree'])).trim();
    return (
      await git.raw([
        '-c',
        'user.name=NocoBase Git Manager',
        '-c',
        'user.email=git-manager@nocobase.local',
        'commit-tree',
        treeSha,
        '-m',
        `Snapshot selected folders from ${sourceSha}`,
      ])
    ).trim();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function createPreview(git: SimpleGit, config: SubtreeConfig): Promise<PreviewResult> {
  validateBranch(config.sourceBranch);
  validateBranch(config.targetBranch);
  if (config.sourceBranch === config.targetBranch) {
    throw new Error('Source branch and target branch must be different');
  }
  const prefixes = validateSubtreePrefixes(config.sourcePrefixes);
  const remoteName = validateRemoteName(config.remoteName);
  const sourceRef = `refs/remotes/${remoteName}/${config.sourceBranch}`;
  const targetRef = `refs/remotes/${remoteName}/${config.targetBranch}`;

  await assertCleanWorkingTree(git);
  await assertGitBranchFormat(git, config.sourceBranch);
  await assertGitBranchFormat(git, config.targetBranch);
  await git.fetch(remoteName, ['--prune']);
  const sourceSha = await resolveOptionalRef(git, sourceRef);
  if (!sourceSha) throw new Error('Source branch was not found on the configured remote');

  for (const prefix of prefixes) {
    let objectType = '';
    try {
      objectType = (await git.raw(['cat-file', '-t', `${sourceSha}:${prefix}`])).trim();
    } catch {
      throw new Error(`Source folder was not found in the selected source branch: ${prefix}`);
    }
    if (objectType !== 'tree') throw new Error(`Selected source path is not a folder: ${prefix}`);
  }

  const splitSha = await createCombinedSnapshot(git, sourceSha, prefixes);
  if (!/^[a-f0-9]{40,64}$/i.test(splitSha)) throw new Error('Git subtree split did not return a valid commit');

  const targetSha = await resolveOptionalRef(git, targetRef);
  let relationship: SubtreeRelationship = 'target-missing';
  if (targetSha === splitSha) relationship = 'already-up-to-date';
  else if (targetSha) relationship = (await isAncestor(git, targetSha, splitSha)) ? 'fast-forward' : 'diverged';

  return {
    sourceSha,
    splitSha,
    targetExists: !!targetSha,
    targetSha,
    relationship,
    recommendedPolicy: relationship === 'diverged' ? 'merge' : 'fastForward',
    availablePolicies: ['fastForward', 'replace', 'merge'],
  };
}

async function updateTargetRef(git: SimpleGit, config: SubtreeConfig, sha: string): Promise<void> {
  await git.raw(['branch', '-f', config.targetBranch, sha]);
}

async function pushTarget(
  git: SimpleGit,
  config: SubtreeConfig,
  sha: string,
  forceWithLeaseSha?: string,
): Promise<void> {
  const args = ['push'];
  if (forceWithLeaseSha) {
    args.push(`--force-with-lease=refs/heads/${config.targetBranch}:${forceWithLeaseSha}`);
  }
  args.push(config.remoteName, `${sha}:refs/heads/${config.targetBranch}`);
  await git.raw(args);
}

async function mergeTarget(git: SimpleGit, config: SubtreeConfig, preview: PreviewResult): Promise<string> {
  if (!preview.targetSha) return preview.splitSha;

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nocobase-git-subtree-'));
  const worktreePath = path.join(temporaryRoot, 'worktree');
  try {
    await git.raw(['worktree', 'add', '--detach', worktreePath, preview.targetSha]);
    const worktreeGit = createGit(worktreePath);
    try {
      await worktreeGit.raw([
        '-c',
        'user.name=NocoBase Git Manager',
        '-c',
        'user.email=git-manager@nocobase.local',
        'merge',
        preview.splitSha,
        '--allow-unrelated-histories',
        '--no-edit',
      ]);
    } catch (error) {
      await worktreeGit.raw(['merge', '--abort']).catch(() => undefined);
      throw new Error(`Subtree merge has conflicts: ${redactPat(redactError(error).message)}`);
    }
    return (await worktreeGit.revparse(['HEAD'])).trim();
  } finally {
    await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function loadConfigAndRepository(ctx: Context, configId: number | string) {
  const configRecord = await ctx.db.getRepository('gitSubtreeConfigs').findOne({ filterByTk: configId });
  if (!configRecord) ctx.throw(404, 'Subtree configuration not found');
  const config = recordToConfig(configRecord as RecordLike);
  if (!config.enabled) ctx.throw(400, 'Subtree configuration is disabled');

  const repo = await ctx.db.getRepository('gitRepositories').findOne({ filterByTk: config.repositoryId });
  if (!repo) ctx.throw(404, 'Repository not found');
  const account = await getRepoAccount(ctx.db, repo);
  if (!account) ctx.throw(400, 'Repository has no Git account configured');

  return { configRecord, config, repo, account };
}

export async function subtreeOptions(ctx: Context, next: () => Promise<void>) {
  const params = getActionParams(ctx);
  const repositoryId = params.repositoryId as number | string;
  if (!repositoryId) ctx.throw(400, 'repositoryId is required');
  const remoteName = validateRemoteName(stringValue(params.remoteName, 'origin') || 'origin');
  const sourceBranch = stringValue(params.sourceBranch);
  if (sourceBranch) validateBranch(sourceBranch);

  const repo = await ctx.db.getRepository('gitRepositories').findOne({ filterByTk: repositoryId });
  if (!repo) ctx.throw(404, 'Repository not found');
  const account = await getRepoAccount(ctx.db, repo);
  if (!account) ctx.throw(400, 'Repository has no Git account configured');
  const localPath = validateLocalPath(stringValue(repo.get('localPath')));
  const repoUrl = stringValue(repo.get('repoUrl'));
  const git = createGit(localPath);

  try {
    const data = await withAuth(
      git,
      localPath,
      repoUrl,
      account.pat,
      async () => {
        if (sourceBranch) await assertGitBranchFormat(git, sourceBranch);
        await git.fetch(remoteName, ['--prune']);
        const branchOutput = await git.raw([
          'for-each-ref',
          '--format=%(refname:strip=3)',
          `refs/remotes/${remoteName}`,
        ]);
        const branches = branchOutput
          .split('\n')
          .map((branch) => branch.trim())
          .filter((branch) => branch && branch !== 'HEAD');
        let folders: string[] = [];
        if (sourceBranch) {
          const sourceRef = `refs/remotes/${remoteName}/${sourceBranch}`;
          if (!(await resolveOptionalRef(git, sourceRef))) {
            throw new Error('Source branch was not found on the configured remote');
          }
          const folderOutput = await git.raw(['ls-tree', '-d', '-r', '--name-only', sourceRef]);
          folders = folderOutput
            .split('\n')
            .map((folder) => folder.trim())
            .filter(Boolean);
        }
        return { branches: Array.from(new Set(branches)).sort(), folders };
      },
      account.username,
      remoteName,
    );
    ctx.body = { success: true, data };
  } catch (error) {
    const safeError = redactError(error);
    ctx.throw(400, ctx.t(safeError.message, { ns: 'plugin-git-manager' }));
  }
  await next();
}

export async function subtreePreview(ctx: Context, next: () => Promise<void>) {
  const params = getActionParams(ctx);
  const configId = params.configId as number | string;
  if (!configId) ctx.throw(400, 'configId is required');
  const { config, repo, account } = await loadConfigAndRepository(ctx, configId);
  const localPath = validateLocalPath(stringValue(repo.get('localPath')));
  const repoUrl = stringValue(repo.get('repoUrl'));
  const git = createGit(localPath);

  try {
    const preview = await withAuth(
      git,
      localPath,
      repoUrl,
      account.pat,
      () => createPreview(git, config),
      account.username,
      config.remoteName,
    );
    ctx.body = { success: true, data: preview };
  } catch (error) {
    const safeError = redactError(error);
    ctx.throw(400, ctx.t(safeError.message, { ns: 'plugin-git-manager' }));
  }
  await next();
}

/**
 * Executes the complete subtree workflow inside the interactive app request.
 * This action intentionally does not enqueue work in the automatic-review queue.
 */
export async function subtreeRunOnAppProcess(ctx: Context, next: () => Promise<void>) {
  const params = getActionParams(ctx);
  const runParams: RunParams = {
    configId: params.configId as number | string,
    policy: validateSubtreePolicy(params.policy),
    push: booleanValue(params.push, true),
    expectedTargetSha: stringValue(params.expectedTargetSha) || undefined,
  };
  if (!runParams.configId) ctx.throw(400, 'configId is required');
  if (runParams.policy === 'replace' && ctx.action.actionName !== 'subtreeReplace') {
    ctx.throw(403, 'Replace policy requires the destructive subtree permission');
  }

  const { config, repo, account } = await loadConfigAndRepository(ctx, runParams.configId);
  const localPath = validateLocalPath(stringValue(repo.get('localPath')));
  const repoUrl = stringValue(repo.get('repoUrl'));
  const git = createGit(localPath);
  const runsRepository = ctx.db.getRepository('gitSubtreeRuns');
  const startedAt = new Date();
  const run = await runsRepository.create({
    values: {
      configId: config.id,
      policy: runParams.policy,
      executionMode: SUBTREE_EXECUTION_MODE,
      status: 'running',
      startedAt,
      triggeredById: (ctx as Context & { state?: { currentUser?: { id?: number | string } } }).state?.currentUser?.id,
    },
  });

  try {
    const result = await withAuth(
      git,
      localPath,
      repoUrl,
      account.pat,
      async () => {
        const preview = await createPreview(git, config);
        let targetAfterSha = preview.splitSha;

        validateRunAgainstPreview(runParams.policy, preview, runParams.expectedTargetSha);
        if (runParams.policy === 'merge') targetAfterSha = await mergeTarget(git, config, preview);

        if (runParams.push) {
          await pushTarget(
            git,
            config,
            targetAfterSha,
            runParams.policy === 'replace' && preview.targetSha ? preview.targetSha : undefined,
          );
        } else {
          await updateTargetRef(git, config, targetAfterSha);
        }
        return { preview, targetAfterSha };
      },
      account.username,
      config.remoteName,
    );

    const finishedAt = new Date();
    await runsRepository.update({
      filterByTk: run.get('id'),
      values: {
        sourceSha: result.preview.sourceSha,
        splitSha: result.preview.splitSha,
        targetBeforeSha: result.preview.targetSha,
        targetAfterSha: result.targetAfterSha,
        status: 'success',
        finishedAt,
        output: `Updated ${config.targetBranch} using ${runParams.policy}`,
      },
    });
    await ctx.db.getRepository('gitSubtreeConfigs').update({
      filterByTk: config.id,
      values: {
        lastRunAt: finishedAt,
        lastSplitSha: result.preview.splitSha,
        lastStatus: 'success',
        lastError: null,
      },
    });
    ctx.body = {
      success: true,
      data: { runId: run.get('id'), executionMode: SUBTREE_EXECUTION_MODE, ...result },
    };
  } catch (error) {
    const safeError = redactError(error);
    const status = /conflict/i.test(safeError.message) ? 'conflict' : 'failed';
    const finishedAt = new Date();
    await runsRepository.update({
      filterByTk: run.get('id'),
      values: { status, finishedAt, error: safeError.message },
    });
    await ctx.db.getRepository('gitSubtreeConfigs').update({
      filterByTk: config.id,
      values: { lastRunAt: finishedAt, lastStatus: status, lastError: safeError.message },
    });
    ctx.throw(status === 'conflict' ? 409 : 400, ctx.t(safeError.message, { ns: 'plugin-git-manager' }));
  }
  await next();
}
