import { createHash } from 'crypto';

/**
 * Server actions for aiBrowser resource.
 */

const ACL_SNIPPET = 'pm.ai-browser';

function getAIBrowserPlugin(ctx: any) {
  return ctx.app.pm.get('plugin-ai-browser') || ctx.app.pm.get('@nocobase/plugin-ai-browser');
}

function userHasAdminSnippet(ctx: any): boolean {
  const roleName = ctx.state?.currentRole || ctx.state?.currentRoles?.[0];
  if (!roleName) return false;
  const role = ctx.app?.acl?.getRole?.(roleName);
  if (!role?.snippetAllowed) return false;
  return role.snippetAllowed(`${ACL_SNIPPET}:list`) || role.snippetAllowed(ACL_SNIPPET);
}

function getAuthUserId(ctx: any) {
  return ctx.auth?.user?.id || ctx.state?.currentUser?.id;
}

async function resolveConversationId(ctx: any, values: any) {
  const explicitId = values?.conversationId || values?.sessionId;
  if (explicitId) {
    return explicitId;
  }

  if (values?.toolCallId) {
    const toolMessage = await ctx.db.getRepository('aiToolMessages').findOne({
      filter: {
        toolCallId: values.toolCallId,
        ...(values?.messageId ? { messageId: values.messageId } : {}),
      },
    });
    const sessionId = toolMessage?.get?.('sessionId') || toolMessage?.sessionId;
    if (sessionId) {
      return sessionId;
    }
  }

  if (values?.messageId) {
    const message = await ctx.db.getRepository('aiMessages').findOne({
      filter: {
        messageId: values.messageId,
      },
    });
    const sessionId = message?.get?.('sessionId') || message?.sessionId;
    if (sessionId) {
      return sessionId;
    }
  }
}

async function assertConversationOwner(ctx: any, conversationId: string) {
  const userId = ctx.auth?.user?.id || ctx.state?.currentUser?.id;
  if (!userId) {
    ctx.throw(403);
  }
  const conversation = await ctx.db.getRepository('aiConversations').findOne({
    filter: {
      sessionId: conversationId,
      userId,
    },
  });
  if (!conversation) {
    ctx.throw(403, 'AI conversation not found or access denied.');
  }
  return userId;
}

function serializeSession(session: any) {
  return typeof session?.toJSON === 'function' ? session.toJSON() : session;
}

export async function getConfig(ctx: any, next: any) {
  const repo = ctx.db.getRepository('aiBrowserConfig');
  const rows = await repo.find();
  const config: Record<string, any> = {};
  for (const row of rows) {
    try {
      config[row.get('key')] = JSON.parse(row.get('value'));
    } catch {
      config[row.get('key')] = row.get('value');
    }
  }
  ctx.body = config;
  await next();
}

export async function setConfig(ctx: any, next: any) {
  const { key, value } = ctx.action.params.values || {};
  if (!key) ctx.throw(400, 'key is required');
  const repo = ctx.db.getRepository('aiBrowserConfig');
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const existing = await repo.findOne({ filter: { key } });
  if (existing) {
    await repo.update({ filterByTk: key, values: { value: serialized } });
  } else {
    await repo.create({ values: { key, value: serialized } });
  }
  ctx.body = { ok: true };
  await next();
}

export async function getDriverStatus(ctx: any, next: any) {
  const plugin = getAIBrowserPlugin(ctx) as any;
  if (!plugin?.driver) {
    ctx.body = { available: false, driver: null };
    await next();
    return;
  }
  const healthy = await plugin.driver.healthCheck().catch(() => false);
  ctx.body = {
    available: healthy,
    driver: plugin.driver.name,
    cdpUrl: process.env.AI_BROWSER_CDP_URL || 'ws://browser:3000',
    liveUrl: process.env.AI_BROWSER_LIVE_URL || null,
  };
  await next();
}

export async function prepareSession(ctx: any, next: any) {
  const values = ctx.action.params.values || ctx.action.params || {};
  const conversationId = await resolveConversationId(ctx, values);
  if (!conversationId) {
    ctx.throw(400, 'conversationId is required.');
  }

  const ownerId = await assertConversationOwner(ctx, conversationId);
  const plugin = getAIBrowserPlugin(ctx) as any;
  if (!plugin?.sessionService) {
    ctx.throw(500, 'AI Browser plugin is not initialized.');
  }

  let session = await plugin.sessionService.getActiveSessionForConversation(conversationId);
  if (session) {
    const externalId = session.get('externalSessionId');
    const metadata = session.get('metadata') || {};
    const driverStatus = externalId
      ? await (plugin.driver?.ensureSession?.(externalId, metadata.driver || {}) ||
          plugin.driver?.getSessionStatus(externalId)).catch(() => null)
      : null;
    if (!driverStatus || driverStatus.status !== 'running') {
      await plugin.sessionService.expireSession(session.get('id')).catch(() => {});
      session = null;
    }
  }
  if (!session) {
    session = await plugin.sessionService.createSession({
      title: values.title || 'Browser Session',
      profileId: values.profileId,
      ownerId,
      conversationId,
      metadata: {
        source: 'chat-approval',
        requestedUrl: values.url || values.requestedUrl || null,
      },
    });
  }

  ctx.body = serializeSession(session);
  await next();
}

export async function markLiveViewOpened(ctx: any, next: any) {
  const values = ctx.action.params.values || ctx.action.params || {};
  const sessionId = values.sessionId || ctx.action.params.filterByTk;
  if (!sessionId) {
    ctx.throw(400, 'sessionId is required.');
  }

  const userId = ctx.auth?.user?.id || ctx.state?.currentUser?.id;
  if (!userId) {
    ctx.throw(403);
  }

  const repo = ctx.db.getRepository('aiBrowserSessions');
  const session = await repo.findById(sessionId);
  if (!session) {
    ctx.throw(404, 'Browser session not found.');
  }
  if (Number(session.get('ownerId')) !== Number(userId)) {
    ctx.throw(403, 'Browser session access denied.');
  }

  await repo.update({
    filterByTk: sessionId,
    values: { liveViewOpened: true },
  });
  ctx.body = { ok: true };
  await next();
}

export async function getScreenshot(ctx: any, next: any) {
  const sessionId = ctx.action.params.filterByTk || ctx.action.params.sessionId;
  if (!sessionId) {
    ctx.throw(400, 'sessionId is required.');
  }

  const userId = ctx.auth?.user?.id || ctx.state?.currentUser?.id;
  if (!userId) {
    ctx.throw(403);
  }

  const repo = ctx.db.getRepository('aiBrowserSessions');
  const session = await repo.findById(sessionId);
  if (!session) {
    ctx.throw(404, 'Browser session not found.');
  }
  if (Number(session.get('ownerId')) !== Number(userId)) {
    ctx.throw(403, 'Browser session access denied.');
  }

  const plugin = getAIBrowserPlugin(ctx) as any;
  const externalId = session.get('externalSessionId');
  const metadata = session.get('metadata') || {};
  if (externalId && plugin.driver?.ensureSession) {
    await plugin.driver.ensureSession(externalId, metadata.driver || {}).catch(() => null);
  }
  const screenshot = externalId ? await plugin.driver?.takeScreenshot(externalId).catch(() => null) : null;
  const currentUrl = externalId ? await plugin.driver?.getCurrentUrl(externalId).catch(() => null) : null;

  ctx.body = {
    screenshot,
    currentUrl,
    status: session.get('status'),
  };
  await next();
}

export async function stopSession(ctx: any, next: any) {
  const values = ctx.action.params.values || ctx.action.params || {};
  const sessionId = values.sessionId || ctx.action.params.filterByTk;
  if (!sessionId) {
    ctx.throw(400, 'sessionId is required.');
  }

  const userId = getAuthUserId(ctx);
  if (!userId) {
    ctx.throw(403);
  }

  const repo = ctx.db.getRepository('aiBrowserSessions');
  const session = await repo.findById(sessionId);
  if (!session) {
    ctx.throw(404, 'Browser session not found.');
  }
  if (!userHasAdminSnippet(ctx) && Number(session.get('ownerId')) !== Number(userId)) {
    ctx.throw(403, 'Browser session access denied.');
  }

  const plugin = getAIBrowserPlugin(ctx) as any;
  await plugin.sessionService.stopSession(sessionId, userId);
  ctx.body = { ok: true };
  await next();
}

function hashText(value: string) {
  return createHash('sha1').update(value || '').digest('hex').slice(0, 16);
}

function normalizeUrlPattern(url?: string) {
  if (!url) {
    return { domain: '', urlPattern: '' };
  }
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/[0-9a-f]{8,}/gi, '*').replace(/\d+/g, '*');
    return {
      domain: parsed.hostname,
      urlPattern: `${parsed.origin}${path}${parsed.search ? '*' : ''}`,
    };
  } catch {
    return { domain: '', urlPattern: url };
  }
}

function getModelValue(model: any, key: string) {
  return model?.get?.(key) ?? model?.[key];
}

export async function buildWorkflowCache(ctx: any, next: any) {
  const values = ctx.action.params.values || ctx.action.params || {};
  const sessionId = values.sessionId || ctx.action.params.filterByTk;
  if (!sessionId) {
    ctx.throw(400, 'sessionId is required.');
  }

  const userId = getAuthUserId(ctx);
  if (!userId) {
    ctx.throw(403);
  }

  const sessionRepo = ctx.db.getRepository('aiBrowserSessions');
  const session = await sessionRepo.findById(sessionId);
  if (!session) {
    ctx.throw(404, 'Browser session not found.');
  }
  if (!userHasAdminSnippet(ctx) && Number(session.get('ownerId')) !== Number(userId)) {
    ctx.throw(403, 'Browser session access denied.');
  }

  const eventRepo = ctx.db.getRepository('aiBrowserActionEvents');
  const events = await eventRepo.find({
    filter: {
      sessionId,
      eventType: {
        $in: ['navigate', 'click', 'type'],
      },
    },
    sort: ['createdAt'],
  });
  const actionableEvents = events.filter((event: any) => {
    const type = getModelValue(event, 'eventType');
    return type === 'navigate' || Boolean(getModelValue(event, 'selector'));
  });
  if (!actionableEvents.length) {
    ctx.throw(400, 'No actionable browser steps were found for this session.');
  }

  const currentUrl = getModelValue(actionableEvents[actionableEvents.length - 1], 'url') || session.get('currentUrl');
  const { domain, urlPattern } = normalizeUrlPattern(currentUrl);
  const taskIntent = values.taskIntent || session.get('title') || `Browser workflow ${sessionId}`;
  const cacheRepo = ctx.db.getRepository('aiBrowserWorkflowCaches');
  const stepRepo = ctx.db.getRepository('aiBrowserCachedSteps');
  const fingerprintRepo = ctx.db.getRepository('aiBrowserElementFingerprints');

  const cache = await cacheRepo.create({
    values: {
      name: values.name || taskIntent,
      domain,
      urlPattern,
      taskIntent,
      taskHash: hashText(`${domain}:${urlPattern}:${taskIntent}`),
      scope: values.scope || 'user',
      ownerId: session.get('ownerId') || userId,
      profileId: session.get('profileId') || null,
      enabled: true,
      confidence: 0.7,
      metadata: {
        source: 'session-action-events',
        sessionId,
        eventCount: actionableEvents.length,
      },
    },
  });
  const workflowCacheId = cache.get('id');

  for (let index = 0; index < actionableEvents.length; index += 1) {
    const event = actionableEvents[index];
    const eventType = getModelValue(event, 'eventType');
    const selector = getModelValue(event, 'selector');
    const url = getModelValue(event, 'url');
    const actionType = eventType === 'navigate' ? 'goto' : eventType;
    const targetKey = selector || url || `step-${index + 1}`;
    const stepKey = `${actionType}-${hashText(`${targetKey}:${index}`)}`;
    const inputBinding =
      actionType === 'goto'
        ? { url }
        : {
            selector,
            text: getModelValue(event, 'inputValue') || undefined,
          };

    await stepRepo.create({
      values: {
        workflowCacheId,
        order: index + 1,
        stepKey,
        intent: getModelValue(event, 'description') || actionType,
        actionType,
        targetKey,
        inputBinding,
        timeoutMs: 30000,
        retryPolicy: { maxRetries: 1, backoffMs: 500 },
        riskLevel: actionType === 'goto' ? 'low' : 'medium',
        requiresApproval: false,
        enabled: true,
        confidence: 0.7,
      },
    });

    if (selector) {
      await fingerprintRepo.create({
        values: {
          workflowCacheId,
          targetKey,
          domain,
          urlPattern,
          cssSelector: selector,
          priority: 50,
          confidence: 0.7,
          lastSeenAt: new Date(),
        },
      });
    }
  }

  const savedCache = await cacheRepo.findOne({
    filterByTk: workflowCacheId,
    appends: ['steps', 'fingerprints'],
  });
  ctx.body = savedCache?.toJSON?.() || savedCache;
  await next();
}
