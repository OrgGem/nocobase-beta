// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import type { Plugin } from '@nocobase/server';
import { asRecord, read } from '../utils/record-utils';

type ActiveRequest = {
  ownerId: string;
  sessionId: string;
  controller: AbortController;
  removeNativeListener?: () => void;
};

// The actual request Context is the capability; clients cannot supply it in a tool call.
const contextRequests = new WeakMap<object, ActiveRequest>();

export function hierarchyRequestSignal(ctx: Context, nativeSignal?: AbortSignal): AbortSignal | undefined {
  const request = contextRequests.get(ctx);
  if (!request) return nativeSignal;
  if (nativeSignal && !request.removeNativeListener) {
    const abort = () => request.controller.abort();
    if (nativeSignal.aborted) abort();
    else {
      nativeSignal.addEventListener('abort', abort, { once: true });
      request.removeNativeListener = () => nativeSignal.removeEventListener('abort', abort);
    }
  }
  return request.controller.signal;
}

export function hasHierarchyRequest(ctx: Context) {
  return contextRequests.has(ctx);
}

/** Cancellation is scoped to this plugin instance, authenticated owner, session, and actual request. */
export class HierarchyRequestCancellation {
  private readonly active = new Map<string, Set<ActiveRequest>>();

  constructor(private readonly plugin: Plugin) {}

  private cancel(ownerId: string, sessionId: string) {
    for (const request of this.active.get(sessionId) ?? []) {
      if (request.ownerId === ownerId) request.controller.abort();
    }
  }

  async middleware(ctx: Context, next: Next) {
    const action = ctx.action;
    if (action?.resourceName !== 'aiConversations') return next();
    const userId = ctx.auth?.user?.id;
    const values = action.params?.values ?? {};
    const sessionId = typeof values.sessionId === 'string' ? values.sessionId : '';
    if (!userId || !sessionId) return next();
    const isAbort = action.actionName === 'abort';
    if (!isAbort && !['sendMessages', 'resendMessages', 'resumeToolCall'].includes(action.actionName)) return next();
    const conversation = await ctx.db.getRepository('aiConversations').findOne({ filter: { sessionId, userId } });
    if (!conversation || read(conversation, 'from') === 'sub-agent') return next();
    const ownerId = String(userId);
    const username = read(conversation, 'aiEmployeeUsername');
    if (typeof username !== 'string' || !username) return next();
    const binding = await ctx.db.getRepository('orchestratorConfig').findOne({
      filter: { leaderUsername: username, enabled: true, routingEnabled: true, routingRole: 'specialist' },
    });
    if (isAbort) {
      const locallyManaged = [...(this.active.get(sessionId) ?? [])].some((request) => request.ownerId === ownerId);
      if (!binding && !locallyManaged) {
        const recorded = await ctx.db.getRepository('agentHierarchyInvocations').findOne({
          filter: { rootSessionId: sessionId, ownerId: userId },
        });
        if (!recorded) return next();
      }
      this.cancel(ownerId, sessionId);
      try {
        if (!this.plugin.name) throw new Error('Plugin name is unavailable.');
        await this.plugin.app.syncMessageManager.publish(this.plugin.name, {
          type: 'hierarchy:abort',
          ownerId,
          sessionId,
        });
      } catch {
        try {
          this.plugin.app.logger.warn('[AgentOrchestrator] Could not synchronize managed request cancellation.');
        } catch {
          // Logging must not prevent the native cancellation action.
        }
      }
      return next();
    }
    if (!binding) return next();

    const request: ActiveRequest = { ownerId, sessionId, controller: new AbortController() };
    let requests = this.active.get(sessionId);
    if (!requests) this.active.set(sessionId, (requests = new Set()));
    requests.add(request);
    contextRequests.set(ctx, request);
    const cleanup = () => {
      request.removeNativeListener?.();
      if (contextRequests.get(ctx) === request) contextRequests.delete(ctx);
      requests.delete(request);
      if (!requests.size && this.active.get(sessionId) === requests) this.active.delete(sessionId);
    };
    // Resume is always SSE in native AI. Normal streaming keeps the host's SSE lifecycle.
    const nonStreaming = action.actionName !== 'resumeToolCall' && values.stream === false;
    try {
      const result = await next();
      if (nonStreaming && request.controller.signal.aborted) {
        return ctx.throw(499, ctx.t('The managed request was cancelled.'));
      }
      return result;
    } catch (error) {
      if (nonStreaming && request.controller.signal.aborted) {
        return ctx.throw(499, ctx.t('The managed request was cancelled.'));
      }
      throw error;
    } finally {
      cleanup();
    }
  }

  handleSyncMessage(message: unknown) {
    const value = asRecord(message);
    if (value.type !== 'hierarchy:abort') return;
    if (typeof value.ownerId !== 'string' || typeof value.sessionId !== 'string') return;
    this.cancel(value.ownerId, value.sessionId);
  }

  abortAll() {
    for (const requests of this.active.values()) {
      for (const request of requests) request.controller.abort();
    }
  }
}
