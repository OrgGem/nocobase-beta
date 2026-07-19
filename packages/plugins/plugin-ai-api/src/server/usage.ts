import { Context } from '@nocobase/actions';

type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

export async function startUsageRecord(
  ctx: Context,
  requestId: string,
  endpoint: string,
  model: string,
  streaming: boolean,
) {
  const body = (ctx.request.body || {}) as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  const oauth = ctx.state.oauthPrincipal as { clientId?: string; subject?: string; scopes?: string[] } | undefined;
  const record = await ctx.db.getRepository('aiApiUsageRecords').create({
    values: {
      requestId,
      userId: String(ctx.state.currentUser?.id),
      roleName: ctx.state.currentRole || ctx.state.currentRoles?.[0] || 'unknown',
      authType: ctx.state.aiApiAuthType || (oauth ? 'oidc' : 'session'),
      oauthClientId: oauth?.clientId,
      oauthSubject: oauth?.subject,
      oauthScopes: oauth?.scopes,
      endpoint,
      mode: ctx.get('X-AI-Mode') || undefined,
      model: model === '-' ? undefined : model,
      status: 'pending',
      streaming,
      startedAt: new Date(),
      requestMetadata: { messageCount: messages?.length, requestedMaxTokens: body.max_tokens },
    },
  });
  return record.id;
}

export async function finishUsageRecord(ctx: Context, id: unknown, startedAt: number, status: 'succeeded' | 'failed') {
  const response = (ctx.body || {}) as { usage?: Usage; id?: string; error?: { code?: string } };
  const usage = response.usage;
  const values = {
    status,
    httpStatus: ctx.status,
    errorCode: response.error?.code,
    inputTokens: usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
    providerRequestId: response.id,
    completedAt: new Date(),
    durationMs: Date.now() - startedAt,
    responseMetadata: { usageSource: usage ? 'response' : 'unavailable' },
  };
  await ctx.db.getRepository('aiApiUsageRecords').update({ filterByTk: id, values });
}
