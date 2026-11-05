/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { z } from 'zod';
import { getAIBrowserPlugin, getBrowserAccess, normalizeToolCall } from './utils';
type ToolRegisterOptions = any;

const browserListSessionsTool: ToolRegisterOptions = {
  groupName: 'browser',
  tool: {
    name: 'list_sessions',
    title: 'List Browser Sessions',
    description: 'List browser sessions. Optionally filter by status.',
    execution: 'backend',
    schema: z.object({
      status: z.string().optional().describe('Filter by status: pending, running, completed, failed, stopped, expired'),
      limit: z.number().optional().describe('Max results (default 20)'),
    }),
    invoke: async (first: any, second: any) => {
      const { ctx, params } = normalizeToolCall(first, second);
      try {
        const plugin = getAIBrowserPlugin(ctx);
        const sessions = await plugin.sessionService.listSessions(getBrowserAccess(ctx), {
          status: params.status,
          limit: params.limit,
        });
        const list = sessions.map((s: any) => ({
          id: s.get('id'),
          title: s.get('title'),
          status: s.get('status'),
          driver: s.get('driver'),
          currentUrl: s.get('currentUrl'),
          startedAt: s.get('startedAt'),
        }));
        return { status: 'success', content: JSON.stringify(list) };
      } catch (err: any) {
        return { status: 'error', content: err.message };
      }
    },
  },
};

export default browserListSessionsTool;
