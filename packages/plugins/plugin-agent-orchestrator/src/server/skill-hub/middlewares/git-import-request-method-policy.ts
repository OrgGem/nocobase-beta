import type { Context } from '@nocobase/actions';

type MethodContext = Context & {
  method?: string;
  set(name: string, value: string): void;
};

const GIT_IMPORT_METHODS = new Map<string, readonly string[]>([
  ['gitListSkills', ['GET', 'HEAD']],
  ['gitSyncSkills', ['POST']],
]);
const GIT_IMPORT_NAMESPACE = 'plugin-agent-orchestrator';

function translateMethodError(ctx: Context): string {
  const key = 'This Skill Hub Git import action does not allow the request method.';
  const translate = (ctx as unknown as { t?: unknown }).t;
  if (typeof translate !== 'function') {
    return key;
  }
  const translated = translate(key, { ns: GIT_IMPORT_NAMESPACE });
  return typeof translated === 'string' ? translated : key;
}

/**
 * Git imports are custom actions rather than collection CRUD. Keep their
 * HTTP contract explicit so a mutation cannot be invoked through a read
 * request (or vice versa).
 */
export function createGitImportRequestMethodPolicy() {
  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    if (ctx.action.resourceName !== 'skillHub') {
      await next();
      return;
    }

    const allowed = GIT_IMPORT_METHODS.get(ctx.action.actionName);
    if (!allowed) {
      await next();
      return;
    }

    const actionContext = ctx as MethodContext;
    const method = String(actionContext.method || '').toUpperCase();
    if (!allowed.includes(method)) {
      actionContext.set('Allow', allowed.join(', '));
      actionContext.throw(405, translateMethodError(ctx));
    }

    await next();
  };
}
