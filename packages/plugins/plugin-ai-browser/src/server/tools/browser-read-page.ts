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

const browserReadPageTool = {
  groupName: 'browser',
  tool: {
    name: 'read_page',
    title: 'Read Browser Page',
    description: `Get the current screenshot and DOM content of the active browser session.
Use this to understand the current state of the page before deciding on the next action.`,
    execution: 'backend',
    schema: z.object({
      maxDomChars: z.number().optional().describe('Maximum page snapshot characters to return (default 10000)'),
    }),
    invoke: async (first: any, second: any, third?: any) => {
      const { ctx, params } = normalizeToolCall(first, second);
      const toolCallId = third;
      const startedAt = Date.now();
      try {
        const plugin = getAIBrowserPlugin(ctx);
        const conversationId = await getConversationId(ctx, params, toolCallId);
        const session = await getActiveBrowserSession(plugin, conversationId);

        const externalId = session.get('externalSessionId');
        const read = await buildReadResult(plugin, externalId, params.maxDomChars || 10000);
        await plugin.sessionService.updateCurrentUrl(session.get('id'), read.currentUrl || '');
        await logBrowserAction(ctx, {
          sessionId: session.get('id'),
          eventType: 'extract',
          description: 'Read current page snapshot',
          url: read.currentUrl,
          durationMs: Date.now() - startedAt,
          metadata: { tool: 'browser_read_page' },
        });
        touchSessionActivity(plugin, session.get('id'));

        return {
          status: 'success',
          content: `Current URL: ${read.currentUrl || ''}\n\nPage snapshot:\n${read.dom}`,
        };
      } catch (err: any) {
        return { status: 'error', content: `Failed to read page: ${err.message}` };
      }
    },
  },
};

export default browserReadPageTool;
