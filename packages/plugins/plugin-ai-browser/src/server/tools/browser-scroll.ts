/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { z } from 'zod';
import {
  buildReadResult,
  getAIBrowserPlugin,
  getActiveBrowserSession,
  getConversationId,
  logBrowserAction,
  normalizeToolCall,
  touchSessionActivity,
} from './utils';

const browserScrollTool = {
  groupName: 'browser',
  tool: {
    name: 'scroll',
    title: 'Scroll Browser Page',
    description: `Scroll the active browser session up, down, top, or bottom.`,
    execution: 'backend',
    schema: z.object({
      direction: z.enum(['up', 'down', 'top', 'bottom']).describe('Direction to scroll'),
    }),
    invoke: async (first: any, second: any, third?: any) => {
      const { ctx, params } = normalizeToolCall(first, second);
      const toolCallId = third;
      const startedAt = Date.now();
      try {
        const plugin = getAIBrowserPlugin(ctx);
        const conversationId = await getConversationId(ctx, params, toolCallId);
        const session = await getActiveBrowserSession(plugin, ctx, conversationId);

        const externalId = session.get('externalSessionId');
        await plugin.driver.scroll(externalId, params.direction);
        const read = await buildReadResult(plugin, externalId, 1500);
        await logBrowserAction(ctx, {
          sessionId: session.get('id'),
          eventType: 'scroll',
          description: `Scrolled ${params.direction}`,
          url: read.currentUrl,
          durationMs: Date.now() - startedAt,
          metadata: { tool: 'browser_scroll', direction: params.direction },
        });
        touchSessionActivity(plugin, session.get('id'));

        return {
          status: 'success',
          content: `Scrolled ${params.direction}.\nCurrent URL: ${read.currentUrl || ''}\n\nPage snapshot:\n${
            read.dom
          }`,
        };
      } catch (err: any) {
        return { status: 'error', content: `Failed to scroll: ${err.message}` };
      }
    },
  },
};

export default browserScrollTool;
