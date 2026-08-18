import type { Plugin } from '@nocobase/server';
import { HarnessProfileService } from '../services/HarnessProfileService';
import { valuesFromCtx } from '../utils/ctx-utils';
import { requestActor, throwResourceError } from './resource-helpers';

// Versioning surface for harness policy profiles. Draft/publish go through HarnessProfileService
// so the revision guards (validated settings, immutable published versions, row-locked version
// numbering) apply to HTTP callers exactly as they do to the loop compiler.
export function registerAgentHarnessProfileResource(plugin: Plugin) {
  const service = new HarnessProfileService(plugin.db);

  plugin.app.resource({
    name: 'agentHarnessProfiles',
    actions: {
      async listVersions(ctx, next) {
        try {
          const profileId = ctx.action.params.filterByTk;
          if (!profileId) ctx.throw(400, 'profile id is required');
          const rows = await plugin.db.getRepository('agentHarnessProfileVersions').find({
            filter: { profileId },
            sort: ['-version'],
          });
          ctx.body = { data: rows };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async saveDraft(ctx, next) {
        try {
          const profileId = ctx.action.params.filterByTk;
          if (!profileId) ctx.throw(400, 'profile id is required');
          const values = valuesFromCtx(ctx);
          ctx.body = {
            data: await service.saveDraft({ profileId, settings: values.settings }),
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async publish(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const values = valuesFromCtx(ctx);
          const versionId = values.versionId ?? ctx.action.params.filterByTk;
          if (!versionId) ctx.throw(400, 'version id is required');
          ctx.body = {
            data: await service.publish(versionId, actor.userId),
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async createProfile(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const values = valuesFromCtx(ctx);
          const result = await service.createProfile({
            tag: typeof values.tag === 'string' ? values.tag : '',
            title: typeof values.title === 'string' ? values.title : '',
            description: typeof values.description === 'string' ? values.description : '',
            enabled: values.enabled !== false,
            settings: values.settings,
            publishedById: actor.userId,
          });
          ctx.body = { data: result };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async validate(ctx, next) {
        try {
          const values = valuesFromCtx(ctx);
          const result = service.validate(values.settings);
          ctx.body = {
            data: result.success
              ? { success: true, issues: [] }
              : { success: false, issues: result.error.issues.map((issue) => issue.message) },
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },
    },
  });
}
