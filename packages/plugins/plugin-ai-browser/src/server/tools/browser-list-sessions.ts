import { z } from 'zod';
import { getAIBrowserPlugin, getCurrentUserId, normalizeToolCall } from './utils';
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
        const sessions = await plugin.sessionService.listSessions({
          ownerId: getCurrentUserId(ctx),
          status: params.status,
          limit: params.limit,
        });
        const list = sessions.map((s: any) => ({
          id: s.get('id'), title: s.get('title'), status: s.get('status'),
          driver: s.get('driver'), currentUrl: s.get('currentUrl'),
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
