import { Context } from '@nocobase/actions';
import type { Application } from '@nocobase/server';
import { parseGitLabProject } from '../utils/gitlab-url';
import { redactPat } from '../utils/redact';

export const WORKER_JOB_GIT_REVIEW_PROCESS = 'git-review:process';
const REVIEW_QUEUE_CHANNEL = 'plugin-git-manager.review';
const REVIEW_QUEUE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.GIT_REVIEW_QUEUE_CONCURRENCY || process.env.GIT_REVIEW_MAX_CONCURRENCY || '3', 10) || 3,
);
const REVIEW_QUEUE_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.GIT_REVIEW_QUEUE_TIMEOUT_MS || '', 10) || 10 * 60 * 1000,
);

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

interface ReviewFlowSnapshot {
  id: number;
  name?: string;
  postMode?: string;
  llmService?: string | null;
  model?: string | null;
  instructions?: string | null;
}

interface ReviewQueueMessage {
  reviewId: number;
  repositoryId: number;
  targetType: 'mr' | 'commit' | 'branch';
  mrIid?: number | null;
  commitSha?: string | null;
  branch?: string | null;
  headSha?: string | null;
  aiEmployeeUsername: string;
  extraInstructions?: string;
  userId?: number | string | null;
  flowSnapshot?: ReviewFlowSnapshot;
}

function getActionParams(ctx: Context) {
  return { ...ctx.action.params, ...ctx.action.params?.values, ...((ctx as any).request?.body || {}) };
}

/**
 * Per-target mutex to prevent two concurrent calls to
 * `triggerReviewInternal` for the same MR / commit / branch from racing
 * `findOne` → `create` and producing two duplicate review rows or
 * scheduling two `runReview`s.
 *
 * Uses `app.lockManager` so the same code path covers both single-node
 * (in-memory `async-mutex`) and HA cluster (Redis-backed Redlock when
 * `plugin-cluster-manager` is active and `LOCK_ADAPTER_DEFAULT=redis`).
 * The locked region only does an upsert + queue publish (a few ms), so a 30s
 * TTL is generous and auto-releases if the process crashes.
 */
function targetKey(args: TriggerArgs): string {
  if (args.targetType === 'mr') return `${args.repositoryId}:mr:${args.mrIid}`;
  if (args.targetType === 'commit') return `${args.repositoryId}:commit:${args.commitSha}`;
  return `${args.repositoryId}:branch:${args.branch}`;
}

const TRIGGER_LOCK_TTL_MS = 30_000;

async function withTriggerLock<T>(app: Application, key: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = `git-review:trigger:${key}`;
  return app.lockManager.runExclusive(lockKey, fn, TRIGGER_LOCK_TTL_MS);
}

/**
 * Trigger an AI-driven code review for an MR / commit / branch.
 * The review record is upserted synchronously, then queued for an available
 * git-review worker. The action returns immediately with the reviewId.
 */
export async function triggerReview(ctx: Context, next: () => Promise<void>) {
  const params = getActionParams(ctx);
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
  return withTriggerLock(app, targetKey(args), () => triggerReviewInternalLocked(app, args));
}

async function triggerReviewInternalLocked(app: Application, args: TriggerArgs): Promise<number> {
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
    // `startedAt` is stamped by the queue worker when execution actually
    // starts. Pending rows may be legitimately waiting in Redis.
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    postStatus: getInitialPostStatus(flow, args.targetType),
    error: null,
  };

  let reviewId: number;
  if (existing) {
    const st = existing.get('status');
    // Treat `pending` the same as `running`: between this fn returning and
    // the scheduled `runReview` flipping the row to `running`, a second
    // caller would otherwise slip past and schedule a duplicate runReview.
    // Stuck `pending` rows (process died before runReview ran) are swept
    // by `recoverStuckReviews` on next startup.
    if (st === 'running' || st === 'pending') {
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

  // Queue for background workers; the action returns as soon as the message is published.
  await enqueueReview(app, {
    reviewId,
    repositoryId: args.repositoryId,
    targetType: args.targetType,
    mrIid: args.targetType === 'mr' ? args.mrIid : null,
    commitSha: args.targetType === 'commit' ? args.commitSha : null,
    branch: args.branch || undefined,
    headSha,
    aiEmployeeUsername,
    extraInstructions: args.extraInstructions,
    userId: args.userId ?? null,
    flowSnapshot: createFlowSnapshot(flow),
  });

  return reviewId;
}

export function registerReviewQueue(app: Application) {
  app.eventQueue.subscribe(REVIEW_QUEUE_CHANNEL, {
    concurrency: REVIEW_QUEUE_CONCURRENCY,
    idle: () => isGitReviewWorker(app),
    process: async (message: ReviewQueueMessage) => {
      await processQueuedReview(app, message);
    },
  });
}

export function unregisterReviewQueue(app: Application) {
  app.eventQueue.unsubscribe(REVIEW_QUEUE_CHANNEL);
}

function createFlowSnapshot(flow: any): ReviewFlowSnapshot {
  return {
    id: Number(flow.get('id')),
    name: flow.get('name') as string,
    postMode: flow.get('postMode') as string,
    llmService: flow.get('llmService') as string | null,
    model: flow.get('model') as string | null,
    instructions: flow.get('instructions') as string | null,
  };
}

function createFlowFromSnapshot(snapshot: ReviewFlowSnapshot | undefined, fallback?: any) {
  return {
    get(name: string) {
      if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, name)) {
        return (snapshot as any)[name];
      }
      return fallback?.get?.(name);
    },
  };
}

function isGitReviewWorker(app: Application): boolean {
  const workerMode = process.env.WORKER_MODE || '';
  return (
    app.serving(WORKER_JOB_GIT_REVIEW_PROCESS) ||
    workerMode === 'worker' ||
    workerMode === 'task' ||
    process.env.APP_ROLE === 'worker'
  );
}

async function enqueueReview(app: Application, message: ReviewQueueMessage) {
  try {
    await app.eventQueue.publish(REVIEW_QUEUE_CHANNEL, message, {
      timeout: REVIEW_QUEUE_TIMEOUT_MS,
      maxRetries: 1,
    });
  } catch (err: any) {
    const safeMessage = redactPat(err?.message || String(err));
    await app.db.getRepository('gitCodeReviews').update({
      filterByTk: message.reviewId,
      values: {
        status: 'failed',
        error: `Failed to enqueue review: ${safeMessage}`,
        finishedAt: new Date(),
      },
    });
    throw err;
  }
}

async function failQueuedReview(app: Application, reviewId: number, err: any) {
  const safeMessage = redactPat(err?.message || String(err));
  await app.db.getRepository('gitCodeReviews').update({
    filterByTk: reviewId,
    values: {
      status: 'failed',
      error: safeMessage,
      finishedAt: new Date(),
    },
  });
}

async function processQueuedReview(app: Application, message: ReviewQueueMessage) {
  const db = app.db;
  const reviewsRepo = db.getRepository('gitCodeReviews');
  const review = await reviewsRepo.findOne({ filterByTk: message.reviewId });
  if (!review) {
    app.log?.warn?.(`git review queue: review ${message.reviewId} not found, skipping`);
    return;
  }

  if (review.get('status') !== 'pending') {
    app.log?.info?.(`git review queue: review ${message.reviewId} is ${review.get('status')}, skipping`);
    return;
  }

  try {
    const repo = await db.getRepository('gitRepositories').findOne({
      filterByTk: message.repositoryId || review.get('repositoryId'),
    });
    if (!repo) throw new Error('Repository not found');

    const storedFlow = await db.getRepository('gitReviewFlows').findOne({
      filterByTk: message.flowSnapshot?.id || review.get('flowId'),
    });
    const flow = createFlowFromSnapshot(message.flowSnapshot, storedFlow);
    const aiEmployeeUsername = message.aiEmployeeUsername || (flow.get('aiEmployeeUsername') as string);
    if (!aiEmployeeUsername) throw new Error('Flow has no AI employee configured');

    await runReview(app, {
      reviewId: message.reviewId,
      flow,
      repo,
      targetType: message.targetType || review.get('targetType'),
      mrIid: message.targetType === 'mr' ? message.mrIid ?? Number(review.get('mrIid')) : null,
      commitSha: message.targetType === 'commit' ? message.commitSha || (review.get('commitSha') as string) : null,
      branch: message.branch || (review.get('branch') as string | undefined),
      headSha: message.headSha || (review.get('headSha') as string | null),
      aiEmployeeUsername,
      extraInstructions: message.extraInstructions,
      userId: message.userId ?? null,
    });
  } catch (err) {
    app.log?.error?.('git review queue: failed before review execution', err);
    await failQueuedReview(app, message.reviewId, err);
  }
}

/**
 * Mark a review as approved and post its content to GitLab as an MR note.
 */
export async function reviewApprovePost(ctx: Context, next: () => Promise<void>) {
  const params = getActionParams(ctx);
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
      error: null,
    },
  });

  ctx.body = { success: true, data: { reviewId, postedNoteId: noteId } };
  await next();
}

/**
 * Reject a pending review (do not post to GitLab).
 */
export async function reviewReject(ctx: Context, next: () => Promise<void>) {
  const params = getActionParams(ctx);
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
    // It needs `app`, `db`, `state.currentUser`, `get(headerName)`, `req.headers`,
    // `action.params.values` (used in getSystemPrompt), and `res.write` (used by
    // ChatStreamProtocol). All stubs are no-ops since we use `invoke` (not stream).
    const syntheticCtx: any = {
      app,
      db,
      isBackgroundReview: true,
      reviewTargetRepositoryId: args.repo.get('id'),
      state: { currentUser: args.userId ? { id: args.userId } : null },
      auth: { user: args.userId ? { id: args.userId } : { id: null } },
      req: { headers: { 'x-timezone': '+00:00', 'x-locale': 'en-US' } },
      // AIEmployee.getSystemPrompt reads ctx.action.params.values.important
      action: { params: { values: {} } },
      // ChatStreamProtocol.write calls ctx.res.write — stub for non-stream invoke
      res: {
        write() {},
        end() {},
        writableEnded: false,
      },
      log: app.logger || console,
      logger: app.logger || console,
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

    const postMode = getFlowPostMode(args.flow);
    let postStatus = getInitialPostStatus(args.flow, args.targetType);
    let postedNoteId: string | null = null;
    let autoPostError: string | null = null;

    if (postMode === 'disabled') {
      postStatus = 'skipped';
    } else if (postMode === 'auto' && args.targetType === 'mr' && args.mrIid) {
      try {
        postedNoteId = String(await postNoteToGitLab(args.repo, args.mrIid, content));
        postStatus = 'posted';
      } catch (err: any) {
        autoPostError = redactPat(err?.message || String(err));
        postStatus = 'post_failed';
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
        error: autoPostError ? `Auto-post failed: ${autoPostError}` : null,
        metadata: {
          flowName: args.flow.get('name'),
          aiEmployeeUsername: args.aiEmployeeUsername,
          llmService,
          model,
          postMode,
          autoPostError,
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
    // Redact PAT before persisting the error — simple-git / fetch errors
    // can echo back the authenticated remote URL in their messages.
    const safeMessage = redactPat(err?.message || String(err));
    await reviewsRepo.update({
      filterByTk: args.reviewId,
      values: {
        status: 'failed',
        error: safeMessage,
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

/**
 * Pick the AI's final reply out of a LangChain-style message list.
 *
 * The previous implementation relied solely on `constructor.name`, which is
 * unsafe under bundling/minification (class names can be mangled to single
 * letters) and after JSON serialisation (instances become plain objects).
 * The new logic checks several signals in order: LangChain's `_getType()`,
 * an explicit `role` field, then the constructor name as a last resort.
 */
function extractLastAiMessageContent(result: any): string {
  const messages = result?.messages;
  if (!Array.isArray(messages)) return '';

  const isAiMessage = (msg: any): boolean => {
    if (!msg) return false;
    if (typeof msg._getType === 'function') {
      try {
        return msg._getType() === 'ai';
      } catch {
        // fall through to other signals
      }
    }
    if (typeof msg.role === 'string') {
      const r = msg.role.toLowerCase();
      return r === 'assistant' || r === 'ai';
    }
    if (typeof msg.type === 'string' && msg.type.toLowerCase() === 'ai') return true;
    const name = msg?.constructor?.name;
    if (name === 'AIMessage' || name === 'AIMessageChunk') return true;
    return false;
  };

  const getContent = (msg: any): string => {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const textBlock = msg.content.find((c: any) => c?.type === 'text');
      if (typeof textBlock?.text === 'string') return textBlock.text;
    }
    return '';
  };

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isAiMessage(msg)) continue;
    const content = getContent(msg);
    if (content) return content;
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
 * execution in a try-catch.
 *
 * Fail-closed: an invalid or oversized pattern means "no branch matches".
 * Reviewing all branches when a user explicitly configured a filter is more
 * dangerous (auto-posts to GitLab, consumes LLM credits) than skipping a
 * malformed flow. The poller logs once per process so misconfiguration is
 * still observable.
 */
const MAX_BRANCH_FILTER_LENGTH = 200;
const loggedBadFilters = new Set<string>();

type ReviewPostMode = 'auto' | 'manual' | 'disabled';

function getFlowPostMode(flow: any): ReviewPostMode {
  const rawValue = flow?.get?.('postMode');
  const value = rawValue && typeof rawValue === 'object' && 'value' in rawValue ? rawValue.value : rawValue;
  const normalized = String(value || 'manual')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (['auto', 'auto_post', 'autopost', 'auto_post_to_mr'].includes(normalized)) return 'auto';
  if (['disabled', 'disable', 'do_not_post', 'dont_post', 'none', 'skip', 'skipped'].includes(normalized)) {
    return 'disabled';
  }
  return 'manual';
}

function getInitialPostStatus(flow: any, targetType: string): string {
  const postMode = getFlowPostMode(flow);
  if (postMode === 'disabled') return 'skipped';
  if (postMode === 'auto' && targetType !== 'mr') return 'skipped';
  return 'pending_approval';
}

function warnInvalidBranchFilter(filter: string, reason: string) {
  if (loggedBadFilters.has(filter)) return;
  loggedBadFilters.add(filter);
  console.warn(
    `[plugin-git-manager] branchFilter rejected (${reason}): ${JSON.stringify(filter)}. Flow will not match any branch.`,
  );
}

export function branchMatches(flow: any, branch: string): boolean {
  const filter = flow.get('branchFilter') as string | null;
  if (!filter) return true;
  if (filter.length > MAX_BRANCH_FILTER_LENGTH) {
    warnInvalidBranchFilter(filter, `too long (>${MAX_BRANCH_FILTER_LENGTH} chars)`);
    return false;
  }
  try {
    return new RegExp(filter).test(branch);
  } catch (err: any) {
    warnInvalidBranchFilter(filter, `invalid regex: ${err?.message || err}`);
    return false;
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

/**
 * Review execution is delegated to the distributed event queue. When a worker
 * restarts mid-run, the DB record can stay in `status='running'` indefinitely.
 * On startup we sweep any `running` review whose `startedAt` is older than the
 * in-process timeout (5 min) plus a safety margin and mark it as failed.
 *
 * The cutoff is intentionally larger than the runtime timeout so concurrent
 * reviews running on a *different* node in an HA cluster aren't clobbered.
 */
const STUCK_REVIEW_CUTOFF_MS = 10 * 60 * 1000; // 10 minutes

export async function recoverStuckReviews(app: Application): Promise<number> {
  try {
    const reviewsRepo = app.db.getRepository('gitCodeReviews');
    const cutoff = new Date(Date.now() - STUCK_REVIEW_CUTOFF_MS);
    // Pending rows may be legitimately waiting in Redis, so only sweep reviews
    // that were actually picked up by a worker.
    const stuck = await reviewsRepo.find({
      filter: {
        status: 'running',
        startedAt: { $lt: cutoff },
      },
    });
    if (!stuck?.length) return 0;
    const finishedAt = new Date();
    for (const review of stuck) {
      const startedAt = review.get('startedAt') as Date | null;
      const durationMs = startedAt ? finishedAt.getTime() - new Date(startedAt).getTime() : null;
      await reviewsRepo.update({
        filterByTk: review.get('id'),
        values: {
          status: 'failed',
          error: 'Review interrupted by application restart',
          finishedAt,
          durationMs,
        },
      });
    }
    app.log?.info?.(`plugin-git-manager: marked ${stuck.length} stuck review(s) as failed after restart`);
    return stuck.length;
  } catch (err: any) {
    app.log?.error?.(`plugin-git-manager: recoverStuckReviews failed: ${err?.message}`);
    return 0;
  }
}
