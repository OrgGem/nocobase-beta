import { Context } from '@nocobase/actions';

export type Usage = { prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null };

function normalizeUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const prompt = source.prompt_tokens ?? source.input_tokens;
  const completion = source.completion_tokens ?? source.output_tokens;
  const total = source.total_tokens;
  if (prompt == null && completion == null && total == null) return undefined;
  return {
    prompt_tokens: typeof prompt === 'number' ? prompt : null,
    completion_tokens: typeof completion === 'number' ? completion : null,
    total_tokens: typeof total === 'number' ? total : null,
  };
}

export async function startUsageRecord(
  ctx: Context,
  requestId: string,
  endpoint: string,
  model: string,
  streaming: boolean,
  mode: 'llm' | 'agent',
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
      mode,
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
  const response = (ctx.body || {}) as {
    usage?: Usage;
    response_metadata?: { usage?: unknown };
    id?: string;
    error?: { code?: string };
  };
  const streamResult = ctx.state.aiApiStreamResult as
    | { usage?: Usage; id?: string; errorCode?: string; succeeded: boolean }
    | undefined;
  const usage =
    normalizeUsage(response.usage) ||
    normalizeUsage(response.response_metadata?.usage) ||
    normalizeUsage(streamResult?.usage);
  const values = {
    status: streamResult ? (streamResult.succeeded ? 'succeeded' : 'failed') : status,
    httpStatus: ctx.status,
    errorCode: response.error?.code || streamResult?.errorCode,
    inputTokens: usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
    providerRequestId: response.id || streamResult?.id,
    completedAt: new Date(),
    durationMs: Date.now() - startedAt,
    responseMetadata: { usageSource: usage ? 'provider' : 'unavailable' },
  };
  await ctx.db.getRepository('aiApiUsageRecords').update({ filterByTk: id, values });
}
