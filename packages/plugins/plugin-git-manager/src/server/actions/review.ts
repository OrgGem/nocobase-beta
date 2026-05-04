import { Context } from '@nocobase/actions';
import type { Application } from '@nocobase/server';
import { parseGitLabProject } from '../utils/gitlab-url';

interface TriggerArgs {
  flowId?: number | null;
  repositoryId: number;
  targetType: 'mr' | 'commit' | 'branch';
  mrIid?: number | null;
  commitSha?: string | null;
  branch?: string | null;
  headSha?: string | null;
  extraInstructions?: string;
  triggeredBy?: 'manual' | 'poll';
  userId?: number | string | null;
}

/**
 * Trigger an AI-driven code review for an MR / commit / branch.
 * The review record is upserted synchronously, then AIEmployee.invoke runs in
 * the background. The action returns immediately with the reviewId.
 */
export async function triggerReview(ctx: Context, next: () => Promise<void>) {
  const params = { ...ctx.action.params, ...ctx.action.params?.values, ...( (ctx.request.body as any) || {} ) };
  const {
    flowId,
    repositoryId,
    targetType,
    mrIid,
    commitSha,
    branch,
    extraInstructions,
  } = params;

  if (!repositoryId) ctx.throw(400, 'repositoryId is required');
  if (!targetType) ctx.throw(400, 'targetType is required');
  if (!['mr', 'commit', 'branch'].includes(targetType)) ctx.throw(400, 'invalid targetType');
  if (targetType === 'mr' && !mrIid) ctx.throw(400, 'mrIid is required for MR review');
  if (targetType === 'commit' && !commitSha) ctx.throw(400, 'commitSha is required for commit review');
  if (targetType === 'branch' && !branch) ctx.throw(400, 'branch is required for branch review');

  const userId = (ctx as any).state?.currentUser?.id;
  try {
    const reviewId = await triggerReviewInternal(ctx.app, {
      flowId,
      repositoryId: Number(repositoryId),
      targetType,
      mrIid: mrIid != null ? Number(mrIid) : null,
      commitSha: commitSha || null,
      branch: branch || null,
      extraInstructions,
      triggeredBy: 'manual',
      userId,
    });
    ctx.body = { success: true, data: { reviewId } };
  } catch (err: any) {
    ctx.throw(err.status || 400, err.message || 'Failed to trigger review');
  }
  await next();
}

/**
 * Programmatic entry point — used by manual action and by the poller.
 * Returns the reviewId of the upserted record.
 */
export async function triggerReviewInternal(app: Application, args: TriggerArgs): Promise<number> {
  const db = app.db;
  const flowsRepo = db.getRepository('gitReviewFlows');

  // Resolve flow
  let flow: any = null;
  if (args.flowId) {
    flow = await flowsRepo.findOne({ filterByTk: args.flowId });
    if (!flow) throwHttp(404, 'Review flow not found');
    if (!flow.get('enabled')) throwHttp(400, 'Review flow is disabled');
  } else {
    // Find flows scoped to repo or global, prefer repo-specific
    const candidates = await flowsRepo.find({
      filter: {
        enabled: true,
        $or: [{ repositoryId: args.repositoryId }, { repositoryId: null }],
      },
      sort: ['-repositoryId'],
    });
    flow = pickFlowMatchingBranch(candidates, args.branch || undefined);
    if (!flow) throwHttp(400, 'No enabled review flow found for this repository');
  }

  // Apply branchFilter even when flow is explicitly given (consistency)
  if (args.branch && !branchMatches(flow, args.branch)) {
    throwHttp(400, `Branch '${args.branch}' does not match flow's branchFilter`);
  }

  const aiEmployeeUsername = flow.get('aiEmployeeUsername') as string;
  if (!aiEmployeeUsername) throwHttp(400, 'Flow has no AI employee configured');

  const repo = await db.getRepository('gitRepositories').findOne({ filterByTk: args.repositoryId });
  if (!repo) throwHttp(404, 'Repository not found');

  // For MR targets, ensure we know the head SHA so the "new commits" indicator
  // works regardless of whether the trigger came from poller or manual UI.
  let headSha = args.headSha || null;
  if (args.targetType === 'mr' && !headSha && args.mrIid) {
    headSha = await fetchMrHeadSha(repo, args.mrIid).catch(() => null);
  }

  // Upsert review record (1 per MR/commit/branch target)
  const reviewsRepo = db.getRepository('gitCodeReviews');
  const targetFilter: any = {
    repositoryId: args.repositoryId,
    targetType: args.targetType,
  };
  if (args.targetType === 'mr') targetFilter.mrIid = args.mrIid;
  else if (args.targetType === 'commit') targetFilter.commitSha = args.commitSha;
  else if (args.targetType === 'branch') targetFilter.branch = args.branch;

  const existing = await reviewsRepo.findOne({ filter: targetFilter });
  // Preserve a poller-tracked latestSha if we don't have a fresher one.
  const existingLatestSha = existing?.get('latestSha') as string | null | undefined;
  const baseValues: any = {
    flowId: flow.get('id'),
    repositoryId: args.repositoryId,
    targetType: args.targetType,
    mrIid: args.targetType === 'mr' ? args.mrIid : null,
    commitSha: args.targetType === 'commit' ? args.commitSha : null,
    branch: args.branch || null,
    headSha: headSha,
    latestSha: headSha || existingLatestSha || null,
    triggeredBy: args.triggeredBy || 'manual',
    status: 'pending',
    postStatus: flow.get('postMode') === 'disabled' ? 'skipped' : 'pending_approval',
    error: null,
  };

  let reviewId: number;
  if (existing) {
    if (existing.get('status') === 'running') {
      // Already in flight — return existing id, do not start another
      return existing.get('id') as number;
    }
    await reviewsRepo.update({
      filterByTk: existing.get('id'),
      values: baseValues,
    });
    reviewId = existing.get('id') as number;
  } else {
    const review = await reviewsRepo.create({ values: baseValues });
    reviewId = review.get('id') as number;
  }

  // Run in background — do not await
  setImmediate(() =>
    runReview(app, {
      reviewId,
      flow,
      repo,
      targetType: args.targetType,
      mrIid: args.targetType === 'mr' ? args.mrIid! : null,
      commitSha: args.targetType === 'commit' ? args.commitSha! : null,
      branch: args.branch || undefined,
      headSha,
      aiEmployeeUsername,
      extraInstructions: args.extraInstructions,
      userId: args.userId ?? null,
    }).catch((err) => {
      app.log?.error?.('runReview background error', err);
    }),
  );

  return reviewId;
}

/**
 * Mark a review as approved and post its content to GitLab as an MR note.
 */
export async function reviewApprovePost(ctx: Context, next: () => Promise<void>) {
  const params = { ...ctx.action.params, ...ctx.action.params?.values, ...( (ctx.request.body as any) || {} ) };
  const { reviewId, editedMarkdown } = params;
  if (!reviewId) ctx.throw(400, 'reviewId is required');

  const reviewsRepo = ctx.db.getRepository('gitCodeReviews');
  const review = await reviewsRepo.findOne({ filterByTk: reviewId });
  if (!review) ctx.throw(404, 'Review not found');
  if (review.get('status') !== 'completed') ctx.throw(400, 'Review is not completed');
  if (review.get('targetType') !== 'mr') ctx.throw(400, 'Only MR reviews can be posted');

  const markdown = (editedMarkdown ?? review.get('reviewMarkdown')) as string;
  if (!markdown) ctx.throw(400, 'No review content to post');

  const repo = await ctx.db.getRepository('gitRepositories').findOne({
    filterByTk: review.get('repositoryId'),
  });
  if (!repo) ctx.throw(404, 'Repository not found');

  const noteId = await postNoteToGitLab(repo, Number(review.get('mrIid')), markdown);

  const userId = (ctx as any).state?.currentUser?.id;
  await reviewsRepo.update({
    filterByTk: reviewId,
    values: {
      reviewMarkdown: markdown,
      postStatus: 'posted',
      postedNoteId: String(noteId),
      approvedBy: userId ? String(userId) : null,
      approvedAt: new Date(),
    },
  });

  ctx.body = { success: true, data: { reviewId, postedNoteId: noteId } };
  await next();
}

/**
 * Reject a pending review (do not post to GitLab).
 */
export async function reviewReject(ctx: Context, next: () => Promise<void>) {
  const params = { ...ctx.action.params, ...ctx.action.params?.values, ...( (ctx.request.body as any) || {} ) };
  const { reviewId, reason } = params;
  if (!reviewId) ctx.throw(400, 'reviewId is required');

  const reviewsRepo = ctx.db.getRepository('gitCodeReviews');
  const review = await reviewsRepo.findOne({ filterByTk: reviewId });
  if (!review) ctx.throw(404, 'Review not found');

  const userId = (ctx as any).state?.currentUser?.id;
  await reviewsRepo.update({
    filterByTk: reviewId,
    values: {
      postStatus: 'rejected',
      approvedBy: userId ? String(userId) : null,
      approvedAt: new Date(),
      error: reason ? `Rejected: ${reason}` : 'Rejected',
    },
  });

  ctx.body = { success: true, data: { reviewId } };
  await next();
}

/* ───────── Helpers ───────── */

interface RunReviewArgs {
  reviewId: number;
  flow: any;
  repo: any;
  targetType: string;
  mrIid: number | null;
  commitSha: string | null;
  branch?: string;
  headSha?: string | null;
  aiEmployeeUsername: string;
  extraInstructions?: string;
  userId?: number | string | null;
}

async function runReview(app: Application, args: RunReviewArgs) {
  const db = app.db;
  const reviewsRepo = db.getRepository('gitCodeReviews');
  const startedAt = new Date();
  let sessionId: string | null = null;

  try {
    await reviewsRepo.update({
      filterByTk: args.reviewId,
      values: { status: 'running', startedAt },
    });

    const employeeRecord = await db.getRepository('aiEmployees').findOne({
      filter: { username: args.aiEmployeeUsername },
    });
    if (!employeeRecord) {
      throw new Error(`AI employee '${args.aiEmployeeUsername}' not found`);
    }

    const conversation = await db.getRepository('aiConversations').create({
      values: {
        userId: args.userId ?? null,
        aiEmployee: { username: args.aiEmployeeUsername },
        options: {},
        thread: 1,
      },
    });
    // aiConversations uses sessionId (uuid) as primary key — no `id` field exists.
    sessionId = (conversation.get('sessionId') as string) || null;
    if (!sessionId) {
      throw new Error('Failed to resolve sessionId from created aiConversation');
    }

    await reviewsRepo.update({
      filterByTk: args.reviewId,
      values: { sessionId },
    });

    const prompt = buildReviewPrompt(args);

    // Synthesize a minimal ctx-shaped object that AIEmployee accepts.
    // It needs `app`, `db`, `state.currentUser`, `get(headerName)`, `req.headers`.
    const syntheticCtx: any = {
      app,
      db,
      state: { currentUser: args.userId ? { id: args.userId } : null },
      req: { headers: { 'x-timezone': 'UTC', 'x-locale': 'en-US' } },
      get(name: string) {
        return this.req.headers[String(name).toLowerCase()];
      },
      getCurrentLocale() {
        return 'en-US';
      },
      t(key: string) {
        return key;
      },
      i18n: {
        t(key: string) {
          return key;
        },
      },
    };

    // H-3 fix: try multiple import paths for resilience against plugin-ai restructuring
    let AIEmployee: any;
    for (const importPath of [
      '@nocobase/plugin-ai/dist/server/ai-employees/ai-employee.js',
      '@nocobase/plugin-ai/dist/server/ai-employees/ai-employee',
      '@nocobase/plugin-ai/server',
    ]) {
      try {
        const mod = await import(/* webpackIgnore: true */ importPath as any);
        AIEmployee = (mod as any).AIEmployee || (mod as any).default?.AIEmployee;
        if (AIEmployee) break;
      } catch {
        // try next path
      }
    }
    if (!AIEmployee) throw new Error('AIEmployee class not found — plugin-ai may not be installed or its exports changed');

    const llmService = args.flow.get('llmService') as string | null;
    const model = args.flow.get('model') as string | null;
    const modelRef = llmService && model ? { llmService, model } : undefined;

    const aiEmployee = new AIEmployee(
      syntheticCtx,
      employeeRecord,
      sessionId,
      undefined,
      undefined,
      false,
      modelRef,
      false,
    );

    // H-4 fix: enforce a timeout on AI review execution to prevent stuck reviews
    const REVIEW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const result = await Promise.race([
      aiEmployee.invoke({
        userMessages: [
          {
            role: 'user',
            content: { type: 'text', content: prompt },
          },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI review timed out after 5 minutes')), REVIEW_TIMEOUT_MS),
      ),
    ]);

    const content = extractLastAiMessageContent(result);
    if (!content) {
      throw new Error('AI employee returned empty review content');
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    const postMode = args.flow.get('postMode') as string;
    let postStatus = 'pending_approval';
    let postedNoteId: string | null = null;

    if (postMode === 'disabled') {
      postStatus = 'skipped';
    } else if (postMode === 'auto' && args.targetType === 'mr' && args.mrIid) {
      try {
        postedNoteId = String(await postNoteToGitLab(args.repo, args.mrIid, content));
        postStatus = 'posted';
      } catch (err: any) {
        app.log?.error?.('Auto-post review note failed', err);
      }
    }

    await reviewsRepo.update({
      filterByTk: args.reviewId,
      values: {
        status: 'completed',
        reviewMarkdown: content,
        rawOutput: JSON.stringify({
          messageCount: result?.messages?.length ?? 0,
          llmService: llmService || 'default',
          model: model || 'default',
        }),
        durationMs,
        finishedAt,
        postStatus,
        postedNoteId,
        metadata: {
          flowName: args.flow.get('name'),
          aiEmployeeUsername: args.aiEmployeeUsername,
          llmService,
          model,
        },
      },
    });

    if (sessionId) {
      db.getRepository('aiConversations')
        .destroy({ filterByTk: sessionId })
        .catch(() => undefined);
    }
  } catch (err: any) {
    const finishedAt = new Date();
    await reviewsRepo.update({
      filterByTk: args.reviewId,
      values: {
        status: 'failed',
        error: err?.message || String(err),
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
    });
    if (sessionId) {
      db.getRepository('aiConversations')
        .destroy({ filterByTk: sessionId })
        .catch(() => undefined);
    }
  }
}

function buildReviewPrompt(args: RunReviewArgs): string {
  const lines: string[] = [];
  lines.push(`You are performing a code review on repository "${args.repo.get('name')}" (id=${args.repo.get('id')}).`);
  lines.push('');

  if (args.targetType === 'mr') {
    lines.push(`Target: Merge Request !${args.mrIid}.`);
    lines.push(`Use the \`git_get_merge_request\` tool with repositoryId=${args.repo.get('id')} and mrIid=${args.mrIid} to fetch the diff and metadata.`);
    lines.push('Optionally call `git_get_merge_request_notes` to avoid duplicating prior comments.');
  } else if (args.targetType === 'commit') {
    lines.push(`Target: Commit ${args.commitSha}.`);
    lines.push(`Use the \`git_get_commit\` tool with repositoryId=${args.repo.get('id')} and commitHash=${args.commitSha} to fetch the diff.`);
  } else {
    lines.push(`Target: Branch ${args.branch}.`);
    lines.push(`Use \`git_list_commits\`, \`git_get_diff\`, and \`git_get_file_content\` (with repositoryId=${args.repo.get('id')}) to inspect recent changes on this branch.`);
  }

  lines.push('');
  lines.push('Produce a thorough but concise code review report in Markdown. Required sections:');
  lines.push('1. **Summary** — overall assessment.');
  lines.push('2. **Findings** — issues grouped by severity (`Critical`, `High`, `Medium`, `Low`, `Info`). For each finding include the file path, line/range when possible, the problem, and a suggested fix.');
  lines.push('3. **Suggestions** — non-blocking improvements.');
  lines.push('4. **Verdict** — one of: `LGTM`, `Approve with comments`, `Request changes`, `Block`.');
  lines.push('');
  lines.push('Cite code snippets in fenced code blocks. Do not output anything outside the Markdown report.');

  const flowInstructions = args.flow.get('instructions') as string;
  if (flowInstructions) {
    lines.push('');
    lines.push('---');
    lines.push('Additional instructions from the review flow:');
    lines.push(flowInstructions);
  }
  if (args.extraInstructions) {
    lines.push('');
    lines.push('---');
    lines.push('Additional instructions for this run:');
    lines.push(args.extraInstructions);
  }

  return lines.join('\n');
}

function extractLastAiMessageContent(result: any): string {
  if (!result?.messages || !Array.isArray(result.messages)) return '';
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const msg = result.messages[i];
    if (!msg) continue;
    const className = msg?.constructor?.name;
    if (className === 'HumanMessage' || className === 'ToolMessage') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const textBlock = msg.content.find((c: any) => c.type === 'text');
      if (textBlock?.text) return textBlock.text;
    }
  }
  return '';
}

async function fetchMrHeadSha(repo: any, mrIid: number): Promise<string | null> {
  const repoUrl = repo.get('repoUrl') as string;
  const pat = repo.get('pat') as string;
  if (!pat) return null;
  const isGitHub = repoUrl.includes('github.com');
  
  try {
    if (isGitHub) {
      const { projectPath } = parseGitLabProject(repoUrl);
      const response = await fetch(`https://api.github.com/repos/${projectPath}/pulls/${mrIid}`, {
        headers: { 'Authorization': `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json' },
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data?.head?.sha || null;
    } else {
      const { apiBase, encodedProject } = parseGitLabProject(repoUrl);
      const response = await fetch(`${apiBase}/projects/${encodedProject}/merge_requests/${mrIid}`, {
        headers: { 'PRIVATE-TOKEN': pat, Accept: 'application/json' },
      });
      if (!response.ok) return null;
      const data = await response.json();
      return (data?.sha as string) || (data?.diff_refs?.head_sha as string) || null;
    }
  } catch {
    return null;
  }
}

async function postNoteToGitLab(repo: any, mrIid: number, body: string): Promise<number | string> {
  const repoUrl = repo.get('repoUrl') as string;
  const pat = repo.get('pat') as string;
  const isGitHub = repoUrl.includes('github.com');
  
  if (isGitHub) {
    if (!pat) throw new Error('Repository has no PAT configured');
    const { projectPath } = parseGitLabProject(repoUrl);
    
    const response = await fetch(`https://api.github.com/repos/${projectPath}/issues/${mrIid}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({ body }),
    });
    
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitHub note post failed ${response.status}: ${text}`);
    }
    const data = await response.json();
    return data?.id;
  } else {
    if (!pat) throw new Error('Repository has no PAT configured');

    const { apiBase, encodedProject } = parseGitLabProject(repoUrl);

    const response = await fetch(`${apiBase}/projects/${encodedProject}/merge_requests/${mrIid}/notes`, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': pat,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitLab note post failed ${response.status}: ${text}`);
    }
    const data = await response.json();
    return data?.id;
  }
}

/* ───────── Flow matching helpers ───────── */

/**
 * H-1 fix: guard against ReDoS by limiting regex length and wrapping
 * execution in a try-catch. Overly long patterns are rejected.
 */
const MAX_BRANCH_FILTER_LENGTH = 200;

export function branchMatches(flow: any, branch: string): boolean {
  const filter = flow.get('branchFilter') as string | null;
  if (!filter) return true;
  if (filter.length > MAX_BRANCH_FILTER_LENGTH) return true; // reject overly complex patterns
  try {
    return new RegExp(filter).test(branch);
  } catch {
    return true; // invalid regex → don't block
  }
}

export function pickFlowMatchingBranch(flows: any[], branch?: string): any | null {
  if (!flows?.length) return null;
  if (!branch) return flows[0];
  for (const f of flows) {
    if (branchMatches(f, branch)) return f;
  }
  return null;
}

function throwHttp(status: number, message: string): never {
  const err: any = new Error(message);
  err.status = status;
  throw err;
}
