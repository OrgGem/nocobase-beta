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

function getValue(model: any, key: string) {
  return model?.get?.(key) ?? model?.[key];
}

function hostnameMatches(currentUrl: string | null, domain: string) {
  if (!domain) return true;
  try {
    const hostname = new URL(currentUrl || '').hostname;
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

async function findWorkflowCache(ctx: any, params: any, currentUrl: string | null) {
  const cacheRepo = ctx.db.getRepository('aiBrowserWorkflowCaches');
  if (params.cacheId) {
    return cacheRepo.findById(params.cacheId);
  }

  const rows = await cacheRepo.find({
    filter: { enabled: true },
    sort: ['-confidence', '-updatedAt'],
    limit: 25,
  });
  const intent = String(params.intent || '').toLowerCase();
  return rows.find((row: any) => {
    const domain = getValue(row, 'domain');
    const taskIntent = String(getValue(row, 'taskIntent') || getValue(row, 'name') || '').toLowerCase();
    return hostnameMatches(currentUrl, domain) && (!intent || taskIntent.includes(intent) || intent.includes(taskIntent));
  });
}

const browserRunCachedWorkflowTool = {
  groupName: 'browser',
  tool: {
    name: 'run_cached_workflow',
    title: 'Run Cached Browser Workflow',
    description: `Execute previously cached browser steps for the active page.
Use this before manually reasoning through a repeated task on the same site/page. Cached steps store selectors and safe action order from previous successful sessions.`,
    execution: 'backend',
    schema: z.object({
      cacheId: z.string().optional().describe('Specific workflow cache ID to run'),
      intent: z.string().optional().describe('Task intent to match when cacheId is not provided'),
      input: z.record(z.string()).optional().describe('Values for cached type steps, keyed by stepKey, targetKey, or selector'),
    }),
    invoke: async (first: any, second: any, third?: any) => {
      const { ctx, params } = normalizeToolCall(first, second);
      const toolCallId = third;
      const startedAt = Date.now();
      let cache: any;
      try {
        const plugin = getAIBrowserPlugin(ctx);
        const conversationId = await getConversationId(ctx, params, toolCallId);
        const session = await getActiveBrowserSession(plugin, conversationId);
        const externalId = session.get('externalSessionId');
        const currentUrl = await plugin.driver.getCurrentUrl(externalId).catch(() => session.get('currentUrl'));
        cache = await findWorkflowCache(ctx, params, currentUrl);
        if (!cache) {
          return { status: 'error', content: 'No matching workflow cache found for the active page.' };
        }

        const cacheId = getValue(cache, 'id');
        const stepRepo = ctx.db.getRepository('aiBrowserCachedSteps');
        const steps = await stepRepo.find({
          filter: { workflowCacheId: cacheId, enabled: true },
          sort: ['order'],
        });
        if (!steps.length) {
          return { status: 'error', content: `Workflow cache ${cacheId} has no enabled steps.` };
        }

        for (const step of steps) {
          const actionType = getValue(step, 'actionType');
          const binding = getValue(step, 'inputBinding') || {};
          const selector = binding.selector || getValue(step, 'targetKey');

          if (actionType === 'goto') {
            const url = binding.url || getValue(step, 'targetKey');
            if (url) {
              const policy = session.get('metadata')?.policy || {};
              if (plugin.policyService && !plugin.policyService.isUrlAllowed(url, policy)) {
                throw new Error(`Cached workflow URL blocked by policy: ${url}`);
              }
              await plugin.driver.navigate(externalId, url);
            }
          } else if (actionType === 'click') {
            await plugin.driver.click(externalId, selector);
          } else if (actionType === 'type') {
            const input = params.input || {};
            const text =
              input[getValue(step, 'stepKey')] ??
              input[getValue(step, 'targetKey')] ??
              input[selector] ??
              (String(binding.text || '').includes('****') ? undefined : binding.text);
            if (typeof text !== 'string') {
              throw new Error(`Cached type step needs input for ${getValue(step, 'stepKey') || selector}`);
            }
            await plugin.driver.type(externalId, selector, text);
          } else if (actionType === 'wait') {
            await plugin.driver.waitFor(externalId, selector, getValue(step, 'timeoutMs') || 30000);
          }

          await stepRepo.update({
            filterByTk: getValue(step, 'id'),
            values: {
              successCount: (getValue(step, 'successCount') || 0) + 1,
            },
          });
        }

        const read = await buildReadResult(plugin, externalId);
        await plugin.sessionService.updateCurrentUrl(session.get('id'), read.currentUrl || '');
        await ctx.db.getRepository('aiBrowserWorkflowCaches').update({
          filterByTk: getValue(cache, 'id'),
          values: {
            successCount: (getValue(cache, 'successCount') || 0) + 1,
            lastSuccessAt: new Date(),
          },
        });
        await logBrowserAction(ctx, {
          sessionId: session.get('id'),
          eventType: 'cached_workflow',
          description: `Ran cached workflow: ${getValue(cache, 'name')}`,
          url: read.currentUrl,
          durationMs: Date.now() - startedAt,
          metadata: { tool: 'browser_run_cached_workflow', cacheId: getValue(cache, 'id') },
        });
        touchSessionActivity(plugin, session.get('id'));

        return {
          status: 'success',
          content: `Cached workflow executed: ${getValue(cache, 'name')}\nCurrent URL: ${read.currentUrl || ''}\n\nPage snapshot:\n${read.dom}`,
        };
      } catch (err: any) {
        if (cache) {
          await ctx.db
            .getRepository('aiBrowserWorkflowCaches')
            .update({
              filterByTk: getValue(cache, 'id'),
              values: {
                failureCount: (getValue(cache, 'failureCount') || 0) + 1,
                lastFailureAt: new Date(),
              },
            })
            .catch(() => {});
        }
        return { status: 'error', content: `Failed to run cached workflow: ${err.message}` };
      }
    },
  },
};

export default browserRunCachedWorkflowTool;
