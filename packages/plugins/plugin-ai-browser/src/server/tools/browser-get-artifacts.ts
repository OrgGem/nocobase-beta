import { z } from 'zod';
import { normalizeToolCall } from './utils';
type ToolRegisterOptions = any;

const browserGetArtifactsTool: ToolRegisterOptions = {
  groupName: 'browser',
  tool: {
    name: 'get_artifacts',
    title: 'Get Session Artifacts',
    description: 'Get screenshots, action logs, and artifacts from a browser session.',
    execution: 'backend',
    schema: z.object({
      sessionId: z.string().describe('Session ID'),
      limit: z.number().optional().describe('Max events to return (default 50)'),
    }),
    invoke: async (first: any, second: any) => {
      const { ctx, params } = normalizeToolCall(first, second);
      try {
        const eventRepo = ctx.db.getRepository('aiBrowserActionEvents');
        const events = await eventRepo.find({
          filter: { sessionId: params.sessionId },
          sort: ['stepIndex', 'createdAt'],
          limit: params.limit || 50,
        });
        const list = events.map((e: any) => ({
          eventType: e.get('eventType'),
          description: e.get('description'),
          url: e.get('url'),
          screenshotPath: e.get('screenshotPath'),
          error: e.get('error'),
          stepIndex: e.get('stepIndex'),
        }));
        return { status: 'success', content: JSON.stringify(list) };
      } catch (err: any) {
        return { status: 'error', content: err.message };
      }
    },
  },
};

export default browserGetArtifactsTool;
