import { Context } from '@nocobase/actions';
import { parseGitLabProject } from '../utils/gitlab-url';

async function gitlabFetch(apiBase: string, endpoint: string, pat: string, params?: Record<string, any>) {
  const url = new URL(`${apiBase}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const response = await fetch(url.toString(), {
    headers: {
      'PRIVATE-TOKEN': pat,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitLab API error ${response.status}: ${body}`);
  }

  // Extract pagination info from response headers
  const totalPages = response.headers.get('x-total-pages');
  const total = response.headers.get('x-total');

  const data = await response.json();
  return { data, totalPages: totalPages ? parseInt(totalPages, 10) : null, total: total ? parseInt(total, 10) : null };
}

async function getRepoWithGitLab(ctx: Context) {
  const { repositoryId } = ctx.action.params;
  const repo = await ctx.db.getRepository('gitRepositories').findOne({
    filterByTk: repositoryId,
  });
  if (!repo) {
    ctx.throw(404, 'Repository not found');
  }
  const pat = repo.get('pat') as string;
  if (!pat) {
    ctx.throw(400, 'Personal Access Token is required for GitLab API access');
  }
  const repoUrl = repo.get('repoUrl') as string;
  const { apiBase, encodedProject } = parseGitLabProject(repoUrl);
  return { repo, pat, apiBase, encodedProject };
}

/**
 * List merge requests for a repository.
 * Params: state (opened|closed|merged|all), search, page, perPage, orderBy, sort
 */
export async function mergeRequests(ctx: Context, next: () => Promise<void>) {
  const { pat, apiBase, encodedProject } = await getRepoWithGitLab(ctx);
  const {
    state = 'opened',
    search,
    page = 1,
    perPage = 20,
    orderBy = 'updated_at',
    sort = 'desc',
  } = ctx.action.params;

  const result = await gitlabFetch(apiBase, `/projects/${encodedProject}/merge_requests`, pat, {
    state,
    search,
    page,
    per_page: Math.min(parseInt(String(perPage), 10) || 20, 100),
    order_by: orderBy,
    sort,
  });

  // Return a clean, minimal shape for the frontend
  const items = (result.data || []).map((mr: any) => ({
    id: mr.id,
    iid: mr.iid,
    title: mr.title,
    description: mr.description,
    state: mr.state,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    author: mr.author ? { name: mr.author.name, username: mr.author.username, avatarUrl: mr.author.avatar_url } : null,
    assignees: (mr.assignees || []).map((a: any) => ({ name: a.name, username: a.username, avatarUrl: a.avatar_url })),
    reviewers: (mr.reviewers || []).map((r: any) => ({ name: r.name, username: r.username, avatarUrl: r.avatar_url })),
    labels: mr.labels || [],
    draft: mr.draft || mr.work_in_progress || false,
    mergedBy: mr.merged_by ? { name: mr.merged_by.name, username: mr.merged_by.username } : null,
    mergedAt: mr.merged_at,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    userNotesCount: mr.user_notes_count || 0,
    upvotes: mr.upvotes || 0,
    downvotes: mr.downvotes || 0,
    webUrl: mr.web_url,
    hasConflicts: mr.has_conflicts || false,
    changesCount: mr.changes_count,
  }));

  ctx.body = {
    success: true,
    data: items,
    pagination: {
      page: parseInt(String(page), 10),
      perPage: parseInt(String(perPage), 10),
      total: result.total,
      totalPages: result.totalPages,
    },
  };
  await next();
}

/**
 * Get single merge request details including changes (diffs).
 * Params: mrIid
 */
export async function mergeRequestDetail(ctx: Context, next: () => Promise<void>) {
  const { pat, apiBase, encodedProject } = await getRepoWithGitLab(ctx);
  const { mrIid } = ctx.action.params;

  if (!mrIid) {
    ctx.throw(400, 'mrIid is required');
  }

  // Fetch MR detail and changes in parallel
  const [mrResult, changesResult] = await Promise.all([
    gitlabFetch(apiBase, `/projects/${encodedProject}/merge_requests/${mrIid}`, pat),
    gitlabFetch(apiBase, `/projects/${encodedProject}/merge_requests/${mrIid}/changes`, pat).catch(() => ({ data: {} })),
  ]);

  const mr = mrResult.data;
  const changes = (changesResult.data?.changes || []).map((c: any) => ({
    oldPath: c.old_path,
    newPath: c.new_path,
    newFile: c.new_file,
    renamedFile: c.renamed_file,
    deletedFile: c.deleted_file,
    diff: c.diff,
  }));

  ctx.body = {
    success: true,
    data: {
      id: mr.id,
      iid: mr.iid,
      title: mr.title,
      description: mr.description,
      state: mr.state,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      author: mr.author ? { name: mr.author.name, username: mr.author.username, avatarUrl: mr.author.avatar_url } : null,
      assignees: (mr.assignees || []).map((a: any) => ({ name: a.name, username: a.username, avatarUrl: a.avatar_url })),
      reviewers: (mr.reviewers || []).map((r: any) => ({ name: r.name, username: r.username, avatarUrl: r.avatar_url })),
      labels: mr.labels || [],
      draft: mr.draft || mr.work_in_progress || false,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      mergedBy: mr.merged_by ? { name: mr.merged_by.name, username: mr.merged_by.username } : null,
      mergedAt: mr.merged_at,
      closedBy: mr.closed_by ? { name: mr.closed_by.name, username: mr.closed_by.username } : null,
      closedAt: mr.closed_at,
      webUrl: mr.web_url,
      hasConflicts: mr.has_conflicts || false,
      diffStats: {
        additions: mr.changes_count ? parseInt(mr.changes_count, 10) : null,
      },
      changes,
    },
  };
  await next();
}

/**
 * Get merge request notes/comments.
 * Params: mrIid, page, perPage
 */
export async function mergeRequestNotes(ctx: Context, next: () => Promise<void>) {
  const { pat, apiBase, encodedProject } = await getRepoWithGitLab(ctx);
  const { mrIid, page = 1, perPage = 50 } = ctx.action.params;

  if (!mrIid) {
    ctx.throw(400, 'mrIid is required');
  }

  const result = await gitlabFetch(apiBase, `/projects/${encodedProject}/merge_requests/${mrIid}/notes`, pat, {
    page,
    per_page: Math.min(parseInt(String(perPage), 10) || 50, 100),
    sort: 'asc',
  });

  const notes = (result.data || [])
    .filter((n: any) => !n.system) // exclude system notes like "assigned to", "changed milestone"
    .map((n: any) => ({
      id: n.id,
      body: n.body,
      author: n.author ? { name: n.author.name, username: n.author.username, avatarUrl: n.author.avatar_url } : null,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
      resolvable: n.resolvable || false,
      resolved: n.resolved || false,
    }));

  ctx.body = {
    success: true,
    data: notes,
    pagination: {
      page: parseInt(String(page), 10),
      perPage: parseInt(String(perPage), 10),
      total: result.total,
      totalPages: result.totalPages,
    },
  };
  await next();
}
