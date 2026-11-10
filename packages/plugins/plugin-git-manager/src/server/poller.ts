/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import { triggerReviewInternal, branchMatches } from './actions/review';
import { parseGitLabProject } from './utils/gitlab-url';
import { getRepoAccount } from './utils/get-repo-account';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MR_PAGE_SIZE = 50;
interface PollerState {
  timer: NodeJS.Timeout | null;
  polling: boolean;
  lastTickAt: Date | null;
  lastError: string | null;
}

const pollers = new WeakMap<Application, PollerState>();

function stateFor(app: Application): PollerState {
  let state = pollers.get(app);
  if (!state) {
    state = { timer: null, polling: false, lastTickAt: null, lastError: null };
    pollers.set(app, state);
  }
  return state;
}

export function startPoller(app: Application) {
  const state = stateFor(app);
  if (state.timer) return;
  app.log?.info?.('plugin-git-manager: starting MR poller (interval 5min)');
  state.timer = setInterval(() => tick(app).catch((e) => app.log?.error?.('poller tick error', e)), POLL_INTERVAL_MS);
}

export function stopPoller(app: Application) {
  const state = stateFor(app);
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

export function getPollerStatus(app: Application) {
  const state = stateFor(app);
  return {
    running: !!state.timer,
    polling: state.polling,
    lastTickAt: state.lastTickAt?.toISOString() ?? null,
    lastError: state.lastError,
    intervalSec: POLL_INTERVAL_MS / 1000,
  };
}

/**
 * Handle returned by `tryAcquirePollerLock`. Caller must invoke `release()`
 * exactly once when done. Returning a handle (rather than a boolean) lets us
 * pin a Sequelize transaction to a single connection so that
 * `pg_advisory_unlock` / `RELEASE_LOCK` run on the same connection that
 * acquired the lock — pool-based queries previously could release on the
 * wrong connection, leaving the lock held until that connection recycled.
 */
interface PollerLockHandle {
  release: () => Promise<void>;
}

const ADVISORY_LOCK_KEY = 777_042;

/**
 * Attempt to acquire a DB-level advisory lock so that only one node in an
 * HA cluster runs the poller at any given time.
 *
 * Returns a handle when acquired, `null` when another node holds the lock.
 * Falls back to a no-op handle when the DB doesn't support advisory locks
 * (SQLite, unknown dialects) or when an unexpected error occurs.
 */
async function tryAcquirePollerLock(app: Application): Promise<PollerLockHandle | null> {
  const noop: PollerLockHandle = { release: async () => undefined };
  const sequelize = (app.db as any).sequelize;
  if (!sequelize) return noop;
  const dialect = sequelize.getDialect?.();

  if (dialect !== 'postgres' && dialect !== 'mysql' && dialect !== 'mariadb') {
    return noop; // SQLite / unknown — no distributed locking, allow
  }

  // A transaction pins all queries (and the lock) to a single connection.
  let transaction: any;
  try {
    transaction = await sequelize.transaction();
  } catch {
    return noop; // can't open txn — fall back to allowing
  }

  try {
    let acquired = false;
    if (dialect === 'postgres') {
      const [results] = await sequelize.query(`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked`, {
        transaction,
      });
      acquired = (results as any)?.[0]?.locked === true;
    } else {
      const [results] = await sequelize.query(`SELECT GET_LOCK('git_poller', 0) AS locked`, { transaction });
      const v = (results as any)?.[0]?.locked;
      acquired = v === 1 || v === '1' || v === true;
    }

    if (!acquired) {
      try {
        await transaction.rollback();
      } catch {
        /* ignore */
      }
      return null;
    }

    return {
      release: async () => {
        try {
          if (dialect === 'postgres') {
            await sequelize.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`, { transaction });
          } else {
            await sequelize.query(`SELECT RELEASE_LOCK('git_poller')`, { transaction });
          }
        } catch {
          // best-effort release — txn close still recycles the connection
        } finally {
          try {
            await transaction.commit();
          } catch {
            try {
              await transaction.rollback();
            } catch {
              /* ignore */
            }
          }
        }
      },
    };
  } catch {
    try {
      await transaction.rollback();
    } catch {
      /* ignore */
    }
    return noop; // on error, fall back to allowing
  }
}

/**
 * Run one poll cycle for all auto-enabled repos. Public so that the
 * gitManager:pollNow action can force a tick on demand.
 */
export async function pollAllRepos(app: Application): Promise<{ scanned: number; triggered: number }> {
  const state = stateFor(app);
  if (state.polling) return { scanned: 0, triggered: 0 };
  // Claim the local guard before awaiting the distributed lock.
  state.polling = true;
  let lock: PollerLockHandle | null = null;
  let scanned = 0;
  let triggered = 0;
  try {
    lock = await tryAcquirePollerLock(app);
    if (!lock) return { scanned: 0, triggered: 0 };
    state.lastTickAt = new Date();
    state.lastError = null;
    const reposRepo = app.db.getRepository('gitRepositories');
    const repos = await reposRepo.find({ filter: { autoReview: true } });
    for (const repo of repos) {
      try {
        const result = await pollOneRepoUnlocked(app, repo);
        scanned += result.scanned;
        triggered += result.triggered;
      } catch (err: any) {
        app.log?.error?.(`poller: repo ${repo.get('id')} failed: ${err?.message}`);
      }
    }
  } catch (err: any) {
    state.lastError = err?.message || String(err);
    app.log?.error?.('poller: cycle failed', err);
  } finally {
    try {
      await lock?.release();
    } finally {
      state.polling = false;
    }
  }
  return { scanned, triggered };
}

async function tick(app: Application) {
  await pollAllRepos(app);
}

/**
 * Poll a single repo for MR changes. Returns counts.
 */
export async function pollOneRepo(app: Application, repo: any): Promise<{ scanned: number; triggered: number }> {
  const state = stateFor(app);
  if (state.polling) return { scanned: 0, triggered: 0 };
  state.polling = true;
  let lock: PollerLockHandle | null = null;
  try {
    lock = await tryAcquirePollerLock(app);
    if (!lock) return { scanned: 0, triggered: 0 };
    return await pollOneRepoUnlocked(app, repo);
  } finally {
    try {
      await lock?.release();
    } finally {
      state.polling = false;
    }
  }
}

async function pollOneRepoUnlocked(app: Application, repo: any): Promise<{ scanned: number; triggered: number }> {
  const flowsRepo = app.db.getRepository('gitReviewFlows');
  const reviewsRepo = app.db.getRepository('gitCodeReviews');
  const reposRepo = app.db.getRepository('gitRepositories');

  // Find auto-trigger flows scoped to this repo or global
  const flows = await flowsRepo.find({
    filter: {
      enabled: true,
      triggerMode: { $in: ['onMergeRequestCreated', 'both'] },
      $or: [{ repositoryId: repo.get('id') }, { repositoryId: null }],
    },
    sort: ['-repositoryId'],
  });
  if (!flows?.length) return { scanned: 0, triggered: 0 };

  const primaryFlowId = repo.get('autoReviewFlowId') as number | null;
  const primaryFlow = primaryFlowId
    ? flows.find((flow: any) => Number(flow.get('id')) === Number(primaryFlowId))
    : null;

  // Need PAT to query GitLab
  const account = await getRepoAccount(app.db, repo);
  const pat = account?.pat || '';
  if (!pat) return { scanned: 0, triggered: 0 };

  const pollStartedAt = new Date();
  const mrs = await listMergeRequests(repo, pat);

  let triggered = 0;
  let failed = false;
  for (const mr of mrs) {
    // Prefer the repository's configured primary auto-review flow, then fall
    // back to the first matching auto-trigger flow.
    const flow =
      primaryFlow && branchMatches(primaryFlow, mr.source_branch)
        ? primaryFlow
        : flows.find((f: any) => branchMatches(f, mr.source_branch));
    if (!flow) continue;

    // Preserve the previous one-review-per-MR policy unless new-head reviews are explicitly enabled.
    const existing = await reviewsRepo.findOne({
      filter: {
        repositoryId: repo.get('id'),
        targetType: 'mr',
        mrIid: mr.iid,
      },
      sort: ['-id'],
    });
    if (existing) {
      if (existing.get('latestSha') !== mr.sha) {
        await reviewsRepo.update({
          filterByTk: existing.get('id'),
          values: { latestSha: mr.sha },
        });
      }
      if (!flow.get('reviewOnNewCommits') || existing.get('headSha') === mr.sha) continue;
    }

    try {
      await triggerReviewInternal(app, {
        flowId: flow.get('id'),
        repositoryId: repo.get('id'),
        targetType: 'mr',
        mrIid: mr.iid,
        branch: mr.source_branch,
        headSha: mr.sha,
        triggeredBy: 'poll',
        eventType: existing ? 'head_changed' : 'change_opened',
      });
      triggered++;
    } catch (err: any) {
      failed = true;
      app.log?.error?.(`poller: triggerReviewInternal failed for MR !${mr.iid}: ${err?.message}`);
    }
  }

  if (failed) throw new Error('One or more merge requests could not be queued');
  await reposRepo.update({
    filterByTk: repo.get('id'),
    values: { lastPolledAt: pollStartedAt },
  });

  return { scanned: mrs.length, triggered };
}

async function listMergeRequests(repo: any, pat: string): Promise<any[]> {
  const repoUrl = repo.get('repoUrl') as string;
  const isGitHub = typeof repoUrl === 'string' && new URL(repoUrl).hostname === 'github.com';

  if (isGitHub) {
    const { projectPath } = parseGitLabProject(repoUrl);
    const params = new URLSearchParams({
      state: 'open',
      per_page: String(MR_PAGE_SIZE),
      sort: 'updated',
      direction: 'desc',
    });
    const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
    if (pat) headers['Authorization'] = `Bearer ${pat}`;

    const prs: any[] = [];
    for (let page = 1; ; page++) {
      params.set('page', String(page));
      const response = await fetch(`https://api.github.com/repos/${projectPath}/pulls?${params.toString()}`, {
        headers,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`GitHub API error ${response.status}`);
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error('Invalid GitHub pull request response');
      prs.push(...items);
      if (items.length < MR_PAGE_SIZE) break;
    }
    // Normalise to the GitLab MR shape that pollOneRepo consumes.
    return (prs || []).map((pr: any) => ({
      iid: pr.number,
      sha: pr.head?.sha,
      source_branch: pr.head?.ref,
      target_branch: pr.base?.ref,
    }));
  }

  // GitLab
  const { apiBase, encodedProject } = parseGitLabProject(repoUrl);
  const params = new URLSearchParams({
    state: 'opened',
    per_page: String(MR_PAGE_SIZE),
    order_by: 'updated_at',
    sort: 'desc',
  });
  const mrs: any[] = [];
  for (let page = 1; ; page++) {
    params.set('page', String(page));
    const response = await fetch(`${apiBase}/projects/${encodedProject}/merge_requests?${params.toString()}`, {
      redirect: 'error',
      headers: { 'PRIVATE-TOKEN': pat, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`GitLab API error ${response.status}`);
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error('Invalid GitLab merge request response');
    mrs.push(...items);
    if (items.length < MR_PAGE_SIZE) break;
  }
  return mrs;
}
