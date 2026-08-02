import type { Context, Next } from '@nocobase/actions';

const ACTION_METHODS: Readonly<Record<string, readonly string[]>> = {
  getSettings: ['GET'],
  getPublicConfiguration: ['GET'],
  updateSettings: ['POST'],
  testConnection: ['GET'],
  testConnectionDraft: ['POST'],
  listRepositories: ['GET'],
  listTags: ['GET'],
  getImageDetails: ['GET'],
  getDeleteImpact: ['GET'],
  deleteTag: ['POST'],
  getRepositoryDeleteImpact: ['GET'],
  deleteRepositoryContents: ['POST'],
  downloadImage: ['GET'],
  uploadImage: ['POST'],
};

export function createDockerRegistryRequestMethodPolicy() {
  return async (ctx: Context, next: Next) => {
    if (ctx.action.resourceName !== 'dockerRegistry') {
      await next();
      return;
    }
    const allowed = ACTION_METHODS[ctx.action.actionName];
    if (allowed && !allowed.includes(ctx.method.toUpperCase())) {
      ctx.throw(405, `Method ${ctx.method.toUpperCase()} is not allowed for dockerRegistry:${ctx.action.actionName}`, {
        code: 'METHOD_NOT_ALLOWED',
      });
    }
    await next();
  };
}

export { ACTION_METHODS };
