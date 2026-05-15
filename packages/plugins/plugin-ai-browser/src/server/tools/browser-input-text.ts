import { z } from 'zod';
import {
  buildReadResult,
  getAIBrowserPlugin,
  getActiveBrowserSession,
  getConversationId,
  logBrowserAction,
  normalizeToolCall,
  redactInputValue,
  touchSessionActivity,
} from './utils';

const browserInputTool = {
  groupName: 'browser',
  tool: {
    name: 'input_text',
    title: 'Input Text in Browser',
    description: `Type text into an input field in the active browser session.
Provide a valid CSS/Playwright selector and the text to type.`,
    execution: 'backend',
    schema: z.object({
      selector: z.string().describe('CSS selector or Playwright locator string'),
      text: z.string().describe('The text to type into the element'),
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
        await plugin.driver.type(externalId, params.selector, params.text);
        const read = await buildReadResult(plugin, externalId, 1500);
        await logBrowserAction(ctx, {
          sessionId: session.get('id'),
          eventType: 'type',
          description: `Typed text into: ${params.selector}`,
          url: read.currentUrl,
          selector: params.selector,
          inputValue: redactInputValue(params.text),
          durationMs: Date.now() - startedAt,
          metadata: { tool: 'browser_input_text' },
        });
        touchSessionActivity(plugin, session.get('id'));

        return {
          status: 'success',
          content: `Typed text into: ${params.selector}\nCurrent URL: ${read.currentUrl || ''}\n\nPage snapshot:\n${read.dom}`,
        };
      } catch (err: any) {
        return { status: 'error', content: `Failed to input text: ${err.message}` };
      }
    },
  },
};

export default browserInputTool;
