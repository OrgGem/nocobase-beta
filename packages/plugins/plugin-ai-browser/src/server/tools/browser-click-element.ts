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

const browserClickTool = {
  groupName: 'browser',
  tool: {
    name: 'click_element',
    title: 'Click Element in Browser',
    description: `Click on an element in the active browser session.
You must provide a valid CSS selector or Playwright text selector (e.g. "text=Login" or "button:has-text('Submit')").`,
    execution: 'backend',
    schema: z.object({
      selector: z.string().describe('CSS selector or Playwright locator string'),
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
        await plugin.driver.click(externalId, params.selector);
        const read = await buildReadResult(plugin, externalId, 1500);
        await plugin.sessionService.updateCurrentUrl(session.get('id'), read.currentUrl || '');
        await logBrowserAction(ctx, {
          sessionId: session.get('id'),
          eventType: 'click',
          description: `Clicked element: ${params.selector}`,
          url: read.currentUrl,
          selector: params.selector,
          durationMs: Date.now() - startedAt,
          metadata: { tool: 'browser_click_element' },
        });
        touchSessionActivity(plugin, session.get('id'));

        return {
          status: 'success',
          content: `Clicked element: ${params.selector}\nCurrent URL: ${read.currentUrl || ''}\n\nPage snapshot:\n${
            read.dom
          }`,
        };
      } catch (err: any) {
        return { status: 'error', content: `Failed to click element: ${err.message}` };
      }
    },
  },
};

export default browserClickTool;
