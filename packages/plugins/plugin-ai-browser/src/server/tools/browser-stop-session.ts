import { z } from 'zod';
import { getAIBrowserPlugin, getCurrentUserId, normalizeToolCall } from './utils';
type ToolRegisterOptions = any;

const browserStopSessionTool: ToolRegisterOptions = {
  groupName: 'browser',
  tool: {
    name: 'stop_session',
    title: 'Stop Browser Session',
    description: 'Stop a running browser session and release resources.',
    execution: 'backend',
    schema: z.object({
      sessionId: z.string().describe('Session ID to stop'),
    }),
    invoke: async (first: any, second: any) => {
      const { ctx, params } = normalizeToolCall(first, second);
      try {
        const plugin = getAIBrowserPlugin(ctx);
        await plugin.sessionService.stopSession(params.sessionId, getCurrentUserId(ctx));
        return { status: 'success', content: `Session ${params.sessionId} stopped.` };
      } catch (err: any) {
        return { status: 'error', content: err.message };
      }
    },
  },
};

export default browserStopSessionTool;
