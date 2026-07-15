import { Context } from '@nocobase/actions';
import { parseGitLabProject } from '../utils/gitlab-url';
import { getRepoAccount } from '../utils/get-repo-account';

function getActionParams(ctx: Context) {
  return { ...ctx.action.params, ...ctx.action.params?.values, ...((ctx as any).request?.body || {}) };
}

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
      Accept: 'application/json',
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

async function getRepoApiContext(ctx: Context) {
  // Fix for POST requests where data might be in ctx.request.body
  const params = getActionParams(ctx);
  const { repositoryId } = params;

  const repo = await ctx.db.getRepository('gitRepositories').findOne({
    filterByTk: repositoryId,
  });
  if (!repo) {
    ctx.throw(404, 'Repository not found');
  }

  const account = await getRepoAccount(ctx.db, repo);
  const pat = account?.pat || '';
  const repoUrl = ((repo.get('repoUrl') as string) || '').trim();
  const isGitHub = account?.provider === 'github' || repoUrl.includes('github.com');
  const { apiBase, encodedProject, projectPath } = parseGitLabProject(repoUrl);
  return { repo, pat, apiBase, encodedProject, projectPath, isGitHub };
}

async function githubFetch(endpoint: string, pat: string, params?: Record<string, any>) {
  const url = new URL(`https://api.github.com${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const headers: any = {
    Accept: 'application/vnd.github.v3+json',
  };
  if (pat) {
    headers['Authorization'] = `Bearer ${pat}`;
  }

  const response = await fetch(url.toString(), { headers });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub API error ${response.status}: ${body}`);
  }

  const linkHeader = response.headers.get('link');
  let totalPages = null;
  if (linkHeader) {
    const lastLink = linkHeader.split(',').find((s) => s.includes('rel="last"'));
    if (lastLink) {
      const match = lastLink.match(/page=(\d+)/);
      if (match) totalPages = parseInt(match[1], 10);
    }
  }

  const data = await response.json();
  return { data, totalPages, total: null };
}

export async function mergeRequests(ctx: Context, next: () => Promise<void>) {
  const { pat, apiBase, encodedProject, projectPath, isGitHub } = await getRepoApiContext(ctx);
  // Merge params from query and body
  const params = getActionParams(ctx);
  const { state = 'opened', search, page = 1, perPage = 20, orderBy = 'updated_at', sort = 'desc' } = params;

  let result;
  let items;

  if (isGitHub) {
    // Map GitLab state to GitHub state. `merged` requires fetching `closed`
    // and filtering client-side, since GitHub has no dedicated state.
    const ghState = state === 'opened' ? 'open' : state === 'closed' ? 'closed' : state === 'merged' ? 'closed' : 'all';
    result = await githubFetch(`/repos/${projectPath}/pulls`, pat, {
      state: ghState,
      page,
      per_page: Math.min(parseInt(String(perPage), 10) || 20, 100),
      sort: orderBy === 'updated_at' ? 'updated' : 'created',
      direction: sort,
    });

    let pullRequests = result.data || [];
    // If state is merged, filter the closed ones that are merged.
    // Pagination metadata from GitHub still reflects the unfiltered `closed`
    // total — null it out to avoid misleading the UI.
    let mergedFilterApplied = false;
    if (state === 'merged') {
      pullRequests = pullRequests.filter((pr: any) => pr.merged_at);
      mergedFilterApplied = true;
    }
    if (mergedFilterApplied) {
      result.totalPages = null;
      result.total = null;
    }

    items = pullRequests.map((pr: any) => ({
      id: pr.id,
      iid: pr.number,
      title: pr.title,
      description: pr.body,
      state: pr.state === 'open' ? 'opened' : pr.merged_at ? 'merged' : 'closed',
      sourceBranch: pr.head?.ref,
      targetBranch: pr.base?.ref,
      author: pr.user ? { name: pr.user.login, username: pr.user.login, avatarUrl: pr.user.avatar_url } : null,
      assignees: (pr.assignees || []).map((a: any) => ({ name: a.login, username: a.login, avatarUrl: a.avatar_url })),
      reviewers: (pr.requested_reviewers || []).map((r: any) => ({
        name: r.login,
        username: r.login,
        avatarUrl: r.avatar_url,
      })),
      labels: (pr.labels || []).map((l: any) => l.name),
      draft: pr.draft || false,
      mergedBy: null, // Not returned by the PR list endpoint
      mergedAt: pr.merged_at,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      userNotesCount: typeof pr.comments === 'number' ? pr.comments : 0,
      upvotes: 0,
      downvotes: 0,
      webUrl: pr.html_url,
      // GitHub's PR list does not include mergeability info — surface as
      // `null` (unknown) so the UI doesn't render a misleading "no conflicts".
      hasConflicts: null,
      changesCount: typeof pr.changed_files === 'number' ? pr.changed_files : null,
    }));
  } else {
    if (!pat) ctx.throw(400, 'Personal Access Token is required for GitLab API access');
    result = await gitlabFetch(apiBase, `/projects/${encodedProject}/merge_requests`, pat, {
      state,
      search,
      page,
      per_page: Math.min(parseInt(String(perPage), 10) || 20, 100),
      order_by: orderBy,
      sort,
    });

    items = (result.data || []).map((mr: any) => ({
      id: mr.id,
      iid: mr.iid,
      title: mr.title,
      description: mr.description,
      state: mr.state,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      author: mr.author
        ? { name: mr.author.name, username: mr.author.username, avatarUrl: mr.author.avatar_url }
        : null,
      assignees: (mr.assignees || []).map((a: any) => ({
        name: a.name,
        username: a.username,
        avatarUrl: a.avatar_url,
      })),
      reviewers: (mr.reviewers || []).map((r: any) => ({
        name: r.name,
        username: r.username,
        avatarUrl: r.avatar_url,
      })),
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
  }

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

export async function mergeRequestDetail(ctx: Context, next: () => Promise<void>) {
  const { pat, apiBase, encodedProject, projectPath, isGitHub } = await getRepoApiContext(ctx);
  const params = getActionParams(ctx);
  const { mrIid } = params;

  if (!mrIid) {
    ctx.throw(400, 'mrIid is required');
  }

  let data;
  if (isGitHub) {
    const [prResult, filesResult] = await Promise.all([
      githubFetch(`/repos/${projectPath}/pulls/${mrIid}`, pat),
      githubFetch(`/repos/${projectPath}/pulls/${mrIid}/files`, pat).catch(() => ({ data: [] })),
    ]);

    const pr = prResult.data;
    const changes = (filesResult.data || []).map((c: any) => ({
      oldPath: c.previous_filename || c.filename,
      newPath: c.filename,
      newFile: c.status === 'added',
      renamedFile: c.status === 'renamed',
      deletedFile: c.status === 'removed',
      diff: c.patch,
    }));

    data = {
      id: pr.id,
      iid: pr.number,
      title: pr.title,
      description: pr.body,
      state: pr.state === 'open' ? 'opened' : pr.merged_at ? 'merged' : 'closed',
      sourceBranch: pr.head?.ref,
      targetBranch: pr.base?.ref,
      author: pr.user ? { name: pr.user.login, username: pr.user.login, avatarUrl: pr.user.avatar_url } : null,
      assignees: (pr.assignees || []).map((a: any) => ({ name: a.login, username: a.login, avatarUrl: a.avatar_url })),
      reviewers: (pr.requested_reviewers || []).map((r: any) => ({
        name: r.login,
        username: r.login,
        avatarUrl: r.avatar_url,
      })),
      labels: (pr.labels || []).map((l: any) => l.name),
      draft: pr.draft || false,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      mergedBy: pr.merged_by ? { name: pr.merged_by.login, username: pr.merged_by.login } : null,
      mergedAt: pr.merged_at,
      closedBy: null, // Not always readily available on GitHub without extra call
      closedAt: pr.closed_at,
      webUrl: pr.html_url,
      // `mergeable_state === 'unknown'` when GitHub is still computing — surface
      // `null` instead of `false` so the UI can distinguish "no conflicts" from
      // "not yet known".
      hasConflicts:
        pr.mergeable_state === 'dirty'
          ? true
          : pr.mergeable_state === 'unknown' || pr.mergeable === null
            ? null
            : false,
      diffStats: {
        additions: typeof pr.additions === 'number' ? pr.additions : null,
        deletions: typeof pr.deletions === 'number' ? pr.deletions : null,
        changedFiles: typeof pr.changed_files === 'number' ? pr.changed_files : null,
      },
      changes,
    };
  } else {
    if (!pat) ctx.throw(400, 'Personal Access Token is required for GitLab API access');
    const [mrResult, changesResult] = await Promise.all([
      gitlabFetch(apiBase, `/projects/${encodedProject}/merge_requests/${mrIid}`, pat),
      gitlabFetch(apiBase, `/projects/${encodedProject}/merge_requests/${mrIid}/changes`, pat).catch(() => ({
        data: {},
      })),
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

    data = {
      id: mr.id,
      iid: mr.iid,
      title: mr.title,
      description: mr.description,
      state: mr.state,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      author: mr.author
        ? { name: mr.author.name, username: mr.author.username, avatarUrl: mr.author.avatar_url }
        : null,
      assignees: (mr.assignees || []).map((a: any) => ({
        name: a.name,
        username: a.username,
        avatarUrl: a.avatar_url,
      })),
      reviewers: (mr.reviewers || []).map((r: any) => ({
        name: r.name,
        username: r.username,
        avatarUrl: r.avatar_url,
      })),
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
    };
  }

  ctx.body = {
    success: true,
    data,
  };
  await next();
}

export async function mergeRequestNotes(ctx: Context, next: () => Promise<void>) {
  const { pat, apiBase, encodedProject, projectPath, isGitHub } = await getRepoApiContext(ctx);
  const params = getActionParams(ctx);
  const { mrIid, page = 1, perPage = 50 } = params;

  if (!mrIid) {
    ctx.throw(400, 'mrIid is required');
  }

  let notes = [];
  const pagination = {
    page: parseInt(String(page), 10),
    perPage: parseInt(String(perPage), 10),
    total: null,
    totalPages: null as any,
  };

  if (isGitHub) {
    const result = await githubFetch(`/repos/${projectPath}/issues/${mrIid}/comments`, pat, {
      page,
      per_page: Math.min(parseInt(String(perPage), 10) || 50, 100),
    });

    notes = (result.data || []).map((n: any) => ({
      id: n.id,
      body: n.body,
      author: n.user ? { name: n.user.login, username: n.user.login, avatarUrl: n.user.avatar_url } : null,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
      resolvable: false,
      resolved: false,
    }));
    pagination.totalPages = result.totalPages;
  } else {
    if (!pat) ctx.throw(400, 'Personal Access Token is required for GitLab API access');
    const result = await gitlabFetch(apiBase, `/projects/${encodedProject}/merge_requests/${mrIid}/notes`, pat, {
      page,
      per_page: Math.min(parseInt(String(perPage), 10) || 50, 100),
      sort: 'asc',
    });

    notes = (result.data || [])
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
    pagination.total = result.total;
    pagination.totalPages = result.totalPages;
  }

  ctx.body = {
    success: true,
    data: notes,
    pagination,
  };
  await next();
}
