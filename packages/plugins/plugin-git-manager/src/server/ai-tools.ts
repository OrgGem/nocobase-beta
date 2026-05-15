import { z } from 'zod';
import type { Application } from '@nocobase/server';
import * as gitlabApi from './actions/gitlab-api';
import * as gitActions from './actions/git-actions';

/**
 * Register AI tools that allow an AI employee to inspect git repositories,
 * merge requests, commits, and file content during a review session.
 *
 * Each tool is invoked by the AI runtime; the `invoke` callback constructs a
 * synthetic `ctx.action.params` payload then delegates to the existing
 * resource action implementation.
 */
export function registerGitReviewAiTools(app: Application) {
  const aiManager = (app as any).aiManager;
  if (!aiManager?.toolsManager?.registerTools) {
    app.log?.warn?.('plugin-git-manager: AIManager.toolsManager not available; skipping AI tool registration');
    return;
  }

  /**
   * Enforce that the AI session has an authenticated user and that this user
   * is permitted to invoke the underlying resource:action. Without this check,
   * a prompt-injected AI could pass an arbitrary `repositoryId` to the tools
   * and read any repository's MRs / commits / file content regardless of the
   * caller's ACL.
   */
  const enforceAcl = (ctx: any, resource: string, action: string, params: any) => {
    if (ctx.isBackgroundReview) {
      if (params.repositoryId && params.repositoryId !== ctx.reviewTargetRepositoryId) {
        const err: any = new Error('Permission denied: AI cannot access other repositories');
        err.status = 403;
        throw err;
      }
      return; // Authorized for this specific repository in background context
    }
    const user = ctx?.state?.currentUser;
    if (!user?.id) {
      const err: any = new Error('AI tool requires an authenticated user context');
      err.status = 401;
      throw err;
    }
    const acl = ctx.app?.acl;
    if (!acl?.can) return; // ACL not available — fail-open is acceptable for legacy contexts
    const role =
      ctx?.state?.currentRole ||
      (Array.isArray(user.roles) && user.roles[0]?.name) ||
      null;
    if (!role) {
      const err: any = new Error('AI tool requires a resolvable role on the current user');
      err.status = 403;
      throw err;
    }
    const allowed = acl.can({ role, resource, action });
    if (!allowed) {
      const err: any = new Error(`Permission denied: ${resource}:${action}`);
      err.status = 403;
      throw err;
    }
  };

  const sanitizeForDb = (obj: any): any => {
    if (typeof obj === 'string') {
      // Remove null bytes \u0000 which crash Postgres jsonb/text fields
      // eslint-disable-next-line no-control-regex
      return obj.replace(/\u0000/g, '');
    }
    if (Array.isArray(obj)) {
      return obj.map(sanitizeForDb);
    }
    if (obj && typeof obj === 'object') {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        sanitized[key] = sanitizeForDb(value);
      }
      return sanitized;
    }
    return obj;
  };

  const runResourceAction = async (
    ctx: any,
    handler: (ctx: any, next: () => Promise<void>) => Promise<void>,
    params: Record<string, any>,
    gate: { resource: string; action: string },
  ) => {
    enforceAcl(ctx, gate.resource, gate.action, params);
    const synthCtx: any = {
      ...ctx,
      app: ctx.app,
      db: ctx.db,
      action: { params },
      request: { ...(ctx.request || {}), body: ctx.request?.body || {} },
      throw: (status: number, message: string) => {
        const err: any = new Error(message);
        err.status = status;
        throw err;
      },
    };
    await handler(synthCtx, async () => undefined);
    return sanitizeForDb(synthCtx.body);
  };

  aiManager.toolsManager.registerTools([
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ALLOW',
      silence: false,
      introduction: { title: 'Git: Get merge request' },
      definition: {
        name: 'git_get_merge_request',
        description:
          'Get full details of a GitLab merge request including its file-level diffs. Use this to inspect the code changes that need review.',
        schema: z.object({
          repositoryId: z.number().describe('The numeric ID of the gitRepositories record'),
          mrIid: z.number().describe('The GitLab merge request internal ID (iid)'),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        const body = await runResourceAction(ctx, gitlabApi.mergeRequestDetail, args, {
          resource: 'gitManager',
          action: 'mergeRequestDetail',
        });
        return body?.data ?? body;
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ALLOW',
      silence: false,
      introduction: { title: 'Git: List merge requests' },
      definition: {
        name: 'git_list_merge_requests',
        description: 'List GitLab merge requests for a repository, with optional state and search filters.',
        schema: z.object({
          repositoryId: z.number(),
          state: z.enum(['opened', 'closed', 'merged', 'all']).optional(),
          search: z.string().optional(),
          page: z.number().optional(),
          perPage: z.number().optional(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        const body = await runResourceAction(ctx, gitlabApi.mergeRequests, args, {
          resource: 'gitManager',
          action: 'mergeRequests',
        });
        return body?.data ?? body;
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ALLOW',
      silence: false,
      introduction: { title: 'Git: Get merge request notes' },
      definition: {
        name: 'git_get_merge_request_notes',
        description: 'Get existing comments / notes on a merge request to avoid duplicating feedback.',
        schema: z.object({
          repositoryId: z.number(),
          mrIid: z.number(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        const body = await runResourceAction(ctx, gitlabApi.mergeRequestNotes, args, {
          resource: 'gitManager',
          action: 'mergeRequestNotes',
        });
        return body?.data ?? body;
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ALLOW',
      silence: false,
      introduction: { title: 'Git: Get commit detail' },
      definition: {
        name: 'git_get_commit',
        description: 'Get details and diff of a specific commit in a cloned repository.',
        schema: z.object({
          repositoryId: z.number(),
          commitHash: z.string().describe('Full or short commit SHA'),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        const body = await runResourceAction(ctx, gitActions.commitDetail, args, {
          resource: 'gitManager',
          action: 'commitDetail',
        });
        return body?.data ?? body;
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ALLOW',
      silence: false,
      introduction: { title: 'Git: Get diff' },
      definition: {
        name: 'git_get_diff',
        description:
          'Get the diff between two refs (branches/commits) in a cloned repository, or the diff of a single commit when only commitHash is given.',
        schema: z.object({
          repositoryId: z.number(),
          commitHash: z.string().optional(),
          compareHash: z.string().optional(),
          file: z.string().optional().describe('Optional file path to scope the diff'),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        const body = await runResourceAction(ctx, gitActions.diff, args, {
          resource: 'gitManager',
          action: 'diff',
        });
        return body?.data ?? body;
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ALLOW',
      silence: false,
      introduction: { title: 'Git: Get file content' },
      definition: {
        name: 'git_get_file_content',
        description:
          'Read the content of a single file in a cloned repository at a given ref. Useful when reviewing changes in surrounding context.',
        schema: z.object({
          repositoryId: z.number(),
          filePath: z.string(),
          ref: z.string().optional(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        const body = await runResourceAction(ctx, gitActions.fileContent, args, {
          resource: 'gitManager',
          action: 'fileContent',
        });
        return body?.data ?? body;
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ALLOW',
      silence: false,
      introduction: { title: 'Git: List branches' },
      definition: {
        name: 'git_list_branches',
        description: 'List branches available in a cloned repository.',
        schema: z.object({ repositoryId: z.number() }),
      },
      invoke: async (ctx: any, args: any) => {
        const body = await runResourceAction(ctx, gitActions.branches, args, {
          resource: 'gitManager',
          action: 'branches',
        });
        return body?.data ?? body;
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ALLOW',
      silence: false,
      introduction: { title: 'Git: List recent commits' },
      definition: {
        name: 'git_list_commits',
        description: 'List recent commits in a cloned repository, optionally scoped to a single file.',
        schema: z.object({
          repositoryId: z.number(),
          maxCount: z.number().optional(),
          file: z.string().optional(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        const body = await runResourceAction(ctx, gitActions.log, args, {
          resource: 'gitManager',
          action: 'log',
        });
        return body?.data ?? body;
      },
    },
  ]);

  app.log?.info?.('plugin-git-manager: registered git_* AI tools for code review');
}
