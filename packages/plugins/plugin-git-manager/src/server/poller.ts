import type { Application } from '@nocobase/server';
import { triggerReviewInternal, branchMatches } from './actions/review';
import { parseGitLabProject } from './utils/gitlab-url';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MR_PAGE_SIZE = 50;
/**
 * Maximum duration a single poll cycle is allowed to hold the lock.
 * If a cycle exceeds this, the stale lock is forcibly released so future
 * ticks are not permanently blocked.
 */
const STALE_POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

let timer: NodeJS.Timeout | null = null;
let isPolling = false;
let pollStartedAt: number | null = null;
let lastTickAt: Date | null = null;
let lastError: string | null = null;

/**
 * Start the background poller. Idempotent — calling twice is a no-op.
 * The poller scans repos with autoReview=true, lists their open MRs from GitLab,
 * and triggers a review if no record exists for the MR's current head SHA.
 */
export function startPoller(app: Application) {
  if (timer) return;
  app.log?.info?.('plugin-git-manager: starting MR poller (interval 5min)');
  // First tick after a short delay so app is fully ready
  timer = setInterval(() => tick(app).catch((e) => app.log?.error?.('poller tick error', e)), POLL_INTERVAL_MS);
}

export function stopPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getPollerStatus() {
  return {
    running: !!timer,
    polling: isPolling,
    lastTickAt: lastTickAt?.toISOString() ?? null,
    lastError,
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
      const [results] = await sequelize.query(
        `SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked`,
        { transaction },
      );
      acquired = (results as any)?.[0]?.locked === true;
    } else {
      const [results] = await sequelize.query(
        `SELECT GET_LOCK('git_poller', 0) AS locked`,
        { transaction },
      );
      const v = (results as any)?.[0]?.locked;
      acquired = v === 1 || v === '1' || v === true;
    }

    if (!acquired) {
      try { await transaction.rollback(); } catch { /* ignore */ }
      return null;
    }

    return {
      release: async () => {
        try {
          if (dialect === 'postgres') {
            await sequelize.query(
              `SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`,
              { transaction },
            );
          } else {
            await sequelize.query(
              `SELECT RELEASE_LOCK('git_poller')`,
              { transaction },
            );
          }
        } catch {
          // best-effort release — txn close still recycles the connection
        } finally {
          try { await transaction.commit(); } catch {
            try { await transaction.rollback(); } catch { /* ignore */ }
          }
        }
      },
    };
  } catch {
    try { await transaction.rollback(); } catch { /* ignore */ }
    return noop; // on error, fall back to allowing
  }
}

/**
 * Run one poll cycle for all auto-enabled repos. Public so that the
 * gitManager:pollNow action can force a tick on demand.
 */
export async function pollAllRepos(app: Application): Promise<{ scanned: number; triggered: number }> {
  // M-4 fix: recover from stale isPolling flag
  if (isPolling) {
    if (pollStartedAt && Date.now() - pollStartedAt > STALE_POLL_TIMEOUT_MS) {
      app.log?.warn?.('poller: stale isPolling flag detected — forcibly resetting');
      isPolling = false;
      pollStartedAt = null;
    } else {
      return { scanned: 0, triggered: 0 };
    }
  }

  // C-1 fix: acquire distributed lock for HA — handle pins the connection
  // so unlock runs on the same connection that acquired the lock.
  const lock = await tryAcquirePollerLock(app);
  if (!lock) {
    app.log?.debug?.('poller: another node holds the advisory lock — skipping');
    return { scanned: 0, triggered: 0 };
  }

  isPolling = true;
  pollStartedAt = Date.now();
  lastTickAt = new Date();
  lastError = null;

  let scanned = 0;
  let triggered = 0;

  try {
    const reposRepo = app.db.getRepository('gitRepositories');
    const repos = await reposRepo.find({ filter: { autoReview: true } });
    for (const repo of repos) {
      try {
        const result = await pollOneRepo(app, repo);
        scanned += result.scanned;
        triggered += result.triggered;
      } catch (err: any) {
        app.log?.error?.(`poller: repo ${repo.get('id')} failed: ${err?.message}`);
      }
    }
  } catch (err: any) {
    lastError = err?.message || String(err);
    app.log?.error?.('poller: cycle failed', err);
  } finally {
    isPolling = false;
    pollStartedAt = null;
    await lock.release();
  }
  return { scanned, triggered };
}

async function tick(app: Application) {
  await pollAllRepos(app);
}

/**
 * Poll a single repo for MR changes. Returns counts.
 */
export async function pollOneRepo(
  app: Application,
  repo: any,
): Promise<{ scanned: number; triggered: number }> {
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

  // Need PAT to query GitLab
  const pat = repo.get('pat') as string;
  if (!pat) return { scanned: 0, triggered: 0 };

  const lastPolledAt = repo.get('lastPolledAt') as Date | null;
  const mrs = await listMergeRequests(repo, lastPolledAt);

  let triggered = 0;
  for (const mr of mrs) {
    // Pick first flow whose branchFilter matches this MR's source branch
    const flow = flows.find((f: any) => branchMatches(f, mr.source_branch));
    if (!flow) continue;

    // Auto-poll only triggers for MRs that have NEVER been reviewed.
    // For existing reviews we just refresh latestSha so the UI can flag
    // "new commits available" — re-review must be done manually by the user.
    const existing = await reviewsRepo.findOne({
      filter: {
        repositoryId: repo.get('id'),
        targetType: 'mr',
        mrIid: mr.iid,
      },
    });
    if (existing) {
      if (existing.get('latestSha') !== mr.sha) {
        await reviewsRepo.update({
          filterByTk: existing.get('id'),
          values: { latestSha: mr.sha },
        });
      }
      continue;
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
      });
      triggered++;
    } catch (err: any) {
      app.log?.error?.(`poller: triggerReviewInternal failed for MR !${mr.iid}: ${err?.message}`);
    }
  }

  await reposRepo.update({
    filterByTk: repo.get('id'),
    values: { lastPolledAt: new Date() },
  });

  return { scanned: mrs.length, triggered };
}

async function listMergeRequests(repo: any, updatedAfter: Date | null): Promise<any[]> {
  const repoUrl = repo.get('repoUrl') as string;
  const pat = repo.get('pat') as string;
  const isGitHub = typeof repoUrl === 'string' && repoUrl.includes('github.com');

  if (isGitHub) {
    // GitHub PRs: list endpoint sorts by updated; GitHub has no `updated_after`,
    // so we filter client-side after fetching the most recently updated page.
    const { projectPath } = parseGitLabProject(repoUrl);
    const params = new URLSearchParams({
      state: 'open',
      per_page: String(MR_PAGE_SIZE),
      sort: 'updated',
      direction: 'desc',
    });
    const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
    if (pat) headers['Authorization'] = `Bearer ${pat}`;

    const response = await fetch(
      `https://api.github.com/repos/${projectPath}/pulls?${params.toString()}`,
      { headers },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GitHub API error ${response.status}: ${body}`);
    }
    let prs = (await response.json()) as any[];
    if (Array.isArray(prs) && updatedAfter) {
      const cutoff = updatedAfter.getTime() - 1000;
      prs = prs.filter((pr: any) => {
        const t = pr?.updated_at ? new Date(pr.updated_at).getTime() : 0;
        return t >= cutoff;
      });
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
  if (updatedAfter) {
    // GitLab `updated_after` is exclusive; subtract 1s so MRs updated within
    // the same second as the last poll aren't dropped.
    const safeBound = new Date(updatedAfter.getTime() - 1000);
    params.set('updated_after', safeBound.toISOString());
  }

  const response = await fetch(`${apiBase}/projects/${encodedProject}/merge_requests?${params.toString()}`, {
    headers: { 'PRIVATE-TOKEN': pat, Accept: 'application/json' },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitLab API error ${response.status}: ${body}`);
  }
  return response.json();
}
