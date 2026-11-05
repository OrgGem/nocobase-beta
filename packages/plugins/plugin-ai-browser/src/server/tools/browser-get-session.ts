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
import { getAIBrowserPlugin, getBrowserAccess, normalizeToolCall, touchSessionActivity } from './utils';
type ToolRegisterOptions = any;

const browserGetSessionTool: ToolRegisterOptions = {
  groupName: 'browser',
  tool: {
    name: 'get_session',
    title: 'Get Browser Session',
    description: 'Get details of a browser session including status, current URL, tasks, and live viewer URL.',
    execution: 'backend',
    schema: z.object({
      sessionId: z.string().describe('Session ID to look up'),
    }),
    invoke: async (first: any, second: any) => {
      const { ctx, params } = normalizeToolCall(first, second);
      try {
        const plugin = getAIBrowserPlugin(ctx);
        const session = await plugin.sessionService.getSession(params.sessionId, getBrowserAccess(ctx));
        if (!session) return { status: 'error', content: `Session ${params.sessionId} not found.` };
        touchSessionActivity(plugin, params.sessionId);
        return {
          status: 'success',
          content: JSON.stringify({
            id: session.get('id'),
            title: session.get('title'),
            status: session.get('status'),
            liveUrl: publicLiveUrl(session.get('liveUrl')),
            currentUrl: session.get('currentUrl'),
            driver: session.get('driver'),
            startedAt: session.get('startedAt'),
            endedAt: session.get('endedAt'),
            expiresAt: session.get('expiresAt'),
          }),
        };
      } catch (err: any) {
        return { status: 'error', content: err.message };
      }
    },
  },
};

export default browserGetSessionTool;
