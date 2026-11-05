/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { z } from 'zod';
import { publicLiveUrl } from '../public-live-url';
import {
  buildReadResult,
  getAIBrowserPlugin,
  getConversationId,
  getCurrentUserId,
  getBrowserAccess,
  logBrowserAction,
  normalizeToolCall,
  touchSessionActivity,
} from './utils';

const description = `Open a browser session and navigate to a URL.
If a browser is already open for this conversation, it will navigate the existing browser.
Returns the current screenshot and page content.`;

const browserOpenTool = {
  groupName: 'browser',
  tool: {
    name: 'open_url',
    title: 'Open URL in Browser',
    description,
    execution: 'backend',
    schema: z.object({
      url: z.string().describe('The full URL to navigate to (e.g. https://google.com)'),
      profileId: z.string().optional().describe('Optional profile ID for auth/cookies'),
    }),
    invoke: async (first: any, second: any, third?: any) => {
      const { ctx, params } = normalizeToolCall(first, second);
      const toolCallId = third;
      const startedAt = Date.now();
      try {
        const plugin = getAIBrowserPlugin(ctx);
        const conversationId = await getConversationId(ctx, params, toolCallId);
        if (!conversationId) {
          return { status: 'error', content: 'conversationId is missing in tool context.' };
        }

        // Get or create session
        const access = getBrowserAccess(ctx);
        const conversation = await ctx.db.getRepository('aiConversations').findOne({
          filter: { sessionId: conversationId, userId: access.userId },
        });
        if (!conversation) {
          throw new Error(ctx.t('AI conversation not found or access denied.', { ns: 'plugin-ai-browser' }));
        }
        let session = await plugin.sessionService.getActiveSessionForConversation(conversationId, access);
        let externalId: string | undefined;
        if (session) {
          externalId = session.get('externalSessionId');
          const metadata = session.get('metadata') || {};
          const driverStatus = externalId
            ? await (
                plugin.driver.ensureSession?.(externalId, metadata.driver || {}) ||
                plugin.driver.getSessionStatus(externalId)
              ).catch(() => null)
            : null;
          if (!driverStatus || driverStatus.status !== 'running') {
            await plugin.sessionService.expireSession(session.get('id')).catch(() => {});
            session = null;
            externalId = undefined;
          }
        }

        if (!session) {
          session = await plugin.sessionService.createSession({
            title: `AI Browser for ${params.url}`,
            profileId: params.profileId,
            ownerId: getCurrentUserId(ctx),
            conversationId,
          });
          externalId = session.get('externalSessionId');
        } else {
          externalId = session.get('externalSessionId');
        }

        if (!externalId) {
          throw new Error('Browser session has no external session ID.');
        }
        const policy = session.get('metadata')?.policy || {};
        if (plugin.policyService && !plugin.policyService.isUrlAllowed(params.url, policy)) {
          await logBrowserAction(ctx, {
            sessionId: session.get('id'),
            eventType: 'policy_block',
            description: `Blocked URL by policy: ${params.url}`,
            url: params.url,
            durationMs: Date.now() - startedAt,
            metadata: { tool: 'browser_open_url', policy },
          });
          return {
            status: 'error',
            content: `Blocked by AI Browser policy: ${params.url}`,
          };
        }
        await plugin.driver.navigate(externalId, params.url);
        await plugin.sessionService.updateCurrentUrl(session.get('id'), params.url);

        const read = await buildReadResult(plugin, externalId);
        await logBrowserAction(ctx, {
          sessionId: session.get('id'),
          eventType: 'navigate',
          description: `Opened URL: ${params.url}`,
          url: read.currentUrl || params.url,
          durationMs: Date.now() - startedAt,
          metadata: { tool: 'browser_open_url' },
        });
        touchSessionActivity(plugin, session.get('id'));

        return {
          status: 'success',
          content:
            `URL loaded: ${params.url}\n` +
            `Session ID: ${session.get('id')}\n` +
            `Live Viewer: ${publicLiveUrl(session.get('liveUrl')) || 'not available'}\n` +
            `Current URL: ${read.currentUrl || params.url}\n\n` +
            `Page loaded successfully. If you need to read the content or HTML, use the 'browser_read_page' or 'browser_extract' tools.`,
        };
      } catch (err: any) {
        return { status: 'error', content: `Failed to open URL: ${err.message}` };
      }
    },
  },
};

export default browserOpenTool;
