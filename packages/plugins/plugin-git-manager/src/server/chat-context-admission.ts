// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';
import { loadChatContext } from './actions/chat-context';

type GitContextType = 'git-repository' | 'git-merge-request' | 'git-commit';
type GitContextItem = { type: GitContextType; uid: string; title?: string };
type WorkContextHandler = {
  registerStrategy: (
    type: string,
    strategy: { resolve: (ctx: Context, item: GitContextItem) => Promise<string> },
  ) => void;
};
type AIPlugin = {
  workContextHandler?: WorkContextHandler;
  aiConversationsManager?: {
    getConversation: (options: { sessionId: string; userId: number | string }) => Promise<unknown>;
  };
};
type App = { pm: { get: (name: string) => unknown } };

const TYPES: GitContextType[] = ['git-repository', 'git-merge-request', 'git-commit'];
const registered = new WeakMap<WorkContextHandler, Set<GitContextType>>();
const admitted = new WeakMap<object, Map<string, Record<string, unknown>>>();

function gitContext(value: unknown): GitContextItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.type !== 'string' || !TYPES.includes(item.type as GitContextType)) return null;
  return {
    type: item.type as GitContextType,
    uid: typeof item.uid === 'string' ? item.uid : '',
    ...(typeof item.title === 'string' ? { title: item.title } : {}),
  };
}

function contextParams(ctx: Context, item: GitContextItem): Record<string, unknown> {
  const kind = item.type.slice(4);
  if (!item.uid || !item.uid.trim()) return ctx.throw(400, 'Invalid Git context');
  if (kind === 'repository') return { kind, repositoryId: item.uid };
  const separator = item.uid.indexOf(':');
  if (separator <= 0 || separator === item.uid.length - 1) return ctx.throw(400, 'Invalid Git context');
  const repositoryId = item.uid.slice(0, separator);
  const target = item.uid.slice(separator + 1);
  return kind === 'merge-request' ? { kind, repositoryId, mrIid: target } : { kind, repositoryId, commitHash: target };
}

function contextKey(item: GitContextItem): string {
  return JSON.stringify([item.type, item.uid]);
}

function resolvedItem(item: GitContextItem, content: Record<string, unknown>) {
  const name = typeof content.repositoryName === 'string' ? content.repositoryName : String(content.repositoryId || '');
  let title: string;
  if (item.type === 'git-repository') {
    title = typeof content.name === 'string' ? content.name : String(content.repositoryId || '');
  } else if (item.type === 'git-merge-request') {
    title = [name, `!${content.mrIid}`, content.title].filter(Boolean).join(' · ');
  } else {
    title = [name, String(content.commitSha || '').slice(0, 7), content.subject].filter(Boolean).join(' · ');
  }
  return { type: item.type, uid: item.uid, title, content };
}

function aiPluginFor(app: App): AIPlugin | undefined {
  try {
    return (app.pm.get('ai') || app.pm.get('@nocobase/plugin-ai')) as AIPlugin | undefined;
  } catch {
    return undefined;
  }
}

export function registerGitChatContextStrategies(app: App): boolean {
  const handler = aiPluginFor(app)?.workContextHandler;
  if (!handler || typeof handler.registerStrategy !== 'function') return false;
  const names = registered.get(handler) || new Set<GitContextType>();
  registered.set(handler, names);
  for (const type of TYPES) {
    if (names.has(type)) continue;
    handler.registerStrategy(type, {
      resolve: async (ctx, source) => {
        const item = gitContext(source);
        if (!item) return '';
        try {
          const content =
            admitted.get(ctx)?.get(contextKey(item)) || (await loadChatContext(ctx, contextParams(ctx, item)));
          return JSON.stringify(resolvedItem(item, content));
        } catch {
          return JSON.stringify({ type, content: { unavailable: true } });
        }
      },
    });
    names.add(type);
  }
  return true;
}

async function admitContextItems(ctx: Context, values: unknown): Promise<void> {
  if (!Array.isArray(values)) return;
  for (let index = 0; index < values.length; index += 1) {
    const item = gitContext(values[index]);
    if (!item) continue;
    try {
      if (!registerGitChatContextStrategies(ctx.app)) throw new Error('Git context strategy is unavailable');
      const content = await loadChatContext(ctx, contextParams(ctx, item));
      let cache = admitted.get(ctx);
      if (!cache) {
        cache = new Map();
        admitted.set(ctx, cache);
      }
      cache.set(contextKey(item), content);
      values[index] = resolvedItem(item, content);
    } catch {
      ctx.throw(
        403,
        ctx.t('Git context is unavailable. Check your access and select it again.', { ns: 'plugin-git-manager' }),
      );
    }
  }
}

function recordValue(record: unknown, key: string): unknown {
  if (!record || typeof record !== 'object') return undefined;
  const object = record as { get?: (field: string) => unknown } & Record<string, unknown>;
  return typeof object.get === 'function' ? object.get(key) : object[key];
}

async function admitResentMessage(ctx: Context, values: Record<string, unknown>) {
  const sessionId = typeof values.sessionId === 'string' ? values.sessionId : '';
  const hasMessageId = Object.prototype.hasOwnProperty.call(values, 'messageId');
  let messageId: string | number | undefined;
  if (hasMessageId) {
    const supplied = values.messageId;
    if (typeof supplied === 'number' && Number.isSafeInteger(supplied) && supplied > 0) {
      messageId = supplied;
    } else if (typeof supplied === 'string' && /^\d+$/.test(supplied) && /[1-9]/.test(supplied)) {
      messageId = supplied;
    } else {
      return ctx.throw(400, 'Invalid messageId');
    }
  }
  const userId = ctx.auth?.user?.id;
  const plugin = aiPluginFor(ctx.app);
  if (!sessionId || !userId || !plugin?.aiConversationsManager) return;
  const conversation = await plugin.aiConversationsManager.getConversation({ sessionId, userId });
  if (!conversation) return;
  const repository = ctx.db.getRepository('aiConversations.messages', sessionId);
  const target = hasMessageId
    ? await repository.findOne({ filter: { messageId } })
    : await repository.findOne({ filter: { sessionId }, sort: ['-messageId'] });
  if (!target) return;
  const targetId = recordValue(target, 'messageId');
  if ((typeof targetId !== 'string' && typeof targetId !== 'number') || !targetId) {
    return ctx.throw(400, 'Invalid messageId');
  }
  const message =
    recordValue(target, 'role') === 'user'
      ? target
      : await repository.findOne({
          filter: { sessionId, role: 'user', messageId: { $lt: targetId } },
          sort: ['-messageId'],
        });
  await admitContextItems(ctx, recordValue(message, 'workContext'));
}

export async function enforceGitChatAdmission(ctx: Context, next: () => Promise<void>) {
  if (ctx.action?.resourceName !== 'aiConversations') return next();
  const action = ctx.action.actionName;
  if (action !== 'sendMessages' && action !== 'resendMessages') return next();
  const values = ctx.action.params?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return next();
  if (action === 'sendMessages' && Array.isArray(values.messages)) {
    for (const message of values.messages) {
      if (message && typeof message === 'object' && message.role === 'user') {
        await admitContextItems(ctx, message.workContext);
      }
    }
  } else if (action === 'resendMessages') {
    await admitResentMessage(ctx, values);
  }
  await next();
}
