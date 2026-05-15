import PluginAIBrowserServer from '../plugin';

export function normalizeToolCall(first: any, second: any) {
  if (first?.app || first?.db || first?.state) {
    return { ctx: first, params: second || {} };
  }
  const ctx = second?.context || second || {};
  return { ctx, params: first || {} };
}

export async function getConversationId(ctx: any, params?: any, toolCallId?: string): Promise<string | undefined> {
  let id = (
    params?.conversationId ||
    params?.sessionId ||
    ctx?.state?.conversationId ||
    ctx?.state?.currentConversation?.id ||
    ctx?.conversationId ||
    ctx?.action?.params?.conversationId ||
    ctx?.action?.params?.sessionId ||
    ctx?.action?.params?.filterByTk ||
    ctx?.action?.params?.values?.conversationId ||
    ctx?.action?.params?.values?.sessionId
  );
  if (id) return id;

  if (toolCallId) {
    try {
      const plugin = getAIBrowserPlugin();
      const app = (plugin as any).app;
      if (app && app.db) {
        const toolMessage = await app.db.getRepository('aiToolMessages').findOne({ filter: { toolCallId } });
        const sessionId = toolMessage?.get?.('sessionId') || toolMessage?.sessionId;
        if (sessionId) return sessionId;
      }
    } catch (e) {
      console.warn('[plugin-ai-browser] fallback getConversationId via toolCallId failed', e);
    }
  }

  return undefined;
}

export function getCurrentUserId(ctx: any): number {
  return Number(ctx?.state?.currentUser?.id || ctx?.currentUser?.id || 0);
}

export function getAIBrowserPlugin(ctx?: any) {
  if (PluginAIBrowserServer.instance) {
    return PluginAIBrowserServer.instance;
  }
  const app = ctx?.app;
  const plugin = app?.pm?.get?.('plugin-ai-browser') || app?.pm?.get?.('@nocobase/plugin-ai-browser');
  if (!plugin?.driver || !plugin?.sessionService) {
    throw new Error('AI Browser plugin is not initialized.');
  }
  return plugin;
}

export async function getActiveBrowserSession(plugin: any, conversationId?: string) {
  if (!conversationId) {
    throw new Error('conversationId is missing in tool context.');
  }
  const session = await plugin.sessionService.getActiveSessionForConversation(conversationId);
  if (!session) {
    throw new Error('No active browser session found. Use browser_open_url first.');
  }

  const externalId = session.get('externalSessionId');
  if (externalId && plugin.driver?.ensureSession) {
    const metadata = session.get('metadata') || {};
    const restored = await plugin.driver.ensureSession(externalId, metadata.driver || {});
    if (!restored) {
      throw new Error(`Browser session ${session.get('id')} is no longer attached to Browserless. Use browser_open_url to open a new session.`);
    }
  }

  return session;
}

export async function logBrowserAction(ctx: any, values: Record<string, any>) {
  try {
    const repo = ctx?.db?.getRepository?.('aiBrowserActionEvents');
    if (!repo) return;
    await repo.create({ values });
  } catch (err: any) {
    ctx?.app?.logger?.debug?.(`[plugin-ai-browser] Failed to write action event: ${err?.message || err}`);
  }
}

/**
 * Reset idle timer for a session. Call after every successful tool action.
 */
export function touchSessionActivity(plugin: any, sessionId: string) {
  try {
    plugin?.sessionService?.touchSession?.(sessionId);
  } catch {
    // non-critical — ignore
  }
}

export async function buildReadResult(plugin: any, externalSessionId: string, maxDomChars = 8000) {
  const [screenshot, dom, currentUrl] = await Promise.all([
    plugin.driver.takeScreenshot(externalSessionId),
    plugin.driver.extractDOM(externalSessionId),
    plugin.driver.getCurrentUrl(externalSessionId),
  ]);

  return {
    currentUrl,
    dom: String(dom || '').slice(0, maxDomChars),
  };
}

export function redactInputValue(value: unknown) {
  const text = String(value ?? '');
  if (text.length <= 4) return text ? '****' : '';
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}
