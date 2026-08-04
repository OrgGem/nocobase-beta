import type { Plugin } from '@nocobase/server';
import { LoopRunRepository, type LoopRunRecord } from '../services/LoopRunRepository';
import { requestActor, throwResourceError } from './resource-helpers';

function artifactMetadata(artifact: LoopRunRecord) {
  const { uri: _storageReference, ...metadata } = artifact;
  return metadata;
}

export function registerAgentLoopArtifactResource(plugin: Plugin) {
  const repository = new LoopRunRepository(plugin.db);

  plugin.app.resource({
    name: 'agentLoopArtifactsView',
    actions: {
      async list(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const result = await repository.listArtifacts({
            userId: actor.userId,
            isAdmin: actor.isAdmin,
            filter: ctx.action.params.filter || {},
            sort: ctx.action.params.sort,
            page: Number(ctx.action.params.page),
            pageSize: Number(ctx.action.params.pageSize),
          });
          ctx.body = {
            data: result.rows.map(artifactMetadata),
            meta: {
              count: result.count,
              page: result.page,
              pageSize: result.pageSize,
              totalPage: result.totalPage,
            },
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async get(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const artifactId = ctx.action.params.filterByTk;
          if (!artifactId) ctx.throw(400, 'artifact id is required');
          const artifact = await repository.requireOwnedArtifact(artifactId, actor.userId, actor.isAdmin);
          ctx.body = { data: artifactMetadata(artifact) };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },
    },
  });
}
