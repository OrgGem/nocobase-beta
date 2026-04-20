import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

function handleError(ctx: Context, error: any) {
  const message = error?.message || 'Unknown error';
  ctx.status = 400;
  ctx.body = { errors: [{ message }] };
}

export function createProjectActions(plugin: PluginN8nServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const projects = await client.listAllProjects();
        ctx.body = { data: projects };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
