import { Context } from '@nocobase/actions';
import { finalizeLlmBilling, type LlmBillingState } from './billing';
import { addAiApiUsage } from './utils/app-observability';

export type Usage = {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  prompt_cache_tokens?: number | null;
};

export type AiApiAuthType = 'apiKey' | 'bearer' | 'oidc' | 'unknown';

export interface AiApiUsageResult {
  source: 'provider' | 'unavailable';
  usage?: Usage;
  gatewayResponseId?: string;
  providerRequestId?: string;
}

export interface AiApiStreamResult {
  succeeded: boolean;
  id?: string;
  errorCode?: string;
}

interface OAuthPrincipal {
  clientId?: string;
  subject?: string;
  scopes?: string[];
}

interface AiApiContextState {
  aiApiAuthType?: AiApiAuthType;
  aiApiUsageResult?: AiApiUsageResult;
  aiApiStreamResult?: AiApiStreamResult;
  currentRole?: string;
  currentRoles?: string[];
  currentUser?: { id?: string | number | bigint };
  oauthPrincipal?: OAuthPrincipal;
  aiApiLlmBilling?: LlmBillingState;
}

function getAiApiState(ctx: Context): AiApiContextState {
  return ctx.state as AiApiContextState;
}

function normalizeTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Extract cached prompt tokens from a provider usage or response metadata object.
 * Tolerates both LangChain-style (`input_token_details.cache_read`) and raw
 * OpenAI-style (`prompt_tokens_details.cached_tokens`) shapes.
 */
function extractPromptCacheTokens(source: Record<string, unknown>): number | null {
  const inputDetails = source.input_token_details;
  if (inputDetails && typeof inputDetails === 'object') {
    const cacheRead = (inputDetails as Record<string, unknown>).cache_read;
    if (typeof cacheRead === 'number') return cacheRead;
    const cachedTokens = (inputDetails as Record<string, unknown>).cached_tokens;
    if (typeof cachedTokens === 'number') return cachedTokens;
  }

  const promptDetails = source.prompt_tokens_details;
  if (promptDetails && typeof promptDetails === 'object') {
    const cachedTokens = (promptDetails as Record<string, unknown>).cached_tokens;
    if (typeof cachedTokens === 'number') return cachedTokens;
  }

  if (typeof source.cached_tokens === 'number') return source.cached_tokens;
  if (typeof source.cache_read_tokens === 'number') return source.cache_read_tokens;
  if (typeof source.cache_read === 'number') return source.cache_read;

  return null;
}

export function normalizeUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const prompt = normalizeTokenCount(source.prompt_tokens ?? source.input_tokens);
  const completion = normalizeTokenCount(source.completion_tokens ?? source.output_tokens);
  let total = normalizeTokenCount(source.total_tokens);

  if (total === null && prompt !== null && completion !== null) {
    total = prompt + completion;
  }

  if (prompt === null && completion === null && total === null) return undefined;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    // Keep normalizeUsage idempotent: streaming routes normalize the chunk
    // usage once and hand the result to setAiApiUsageResult, which normalizes
    // again — an already-extracted prompt_cache_tokens must survive that pass.
    prompt_cache_tokens: extractPromptCacheTokens(source) ?? normalizeTokenCount(source.prompt_cache_tokens),
  };
}

export function setAiApiUsageResult(
  ctx: Context,
  value: unknown,
  metadata: Pick<AiApiUsageResult, 'gatewayResponseId' | 'providerRequestId'> = {},
  responseMetadata?: unknown,
): Usage | undefined {
  let usage = normalizeUsage(value);

  // Some providers only surface cached token details on response_metadata; fall
  // back there when the usage object itself does not carry them.
  if (usage?.prompt_cache_tokens === null && responseMetadata && typeof responseMetadata === 'object') {
    const responseMetaRecord = responseMetadata as Record<string, unknown>;
    let cacheTokens = extractPromptCacheTokens(responseMetaRecord);
    // Providers sometimes nest the raw provider usage under response_metadata.usage.
    if (cacheTokens === null && responseMetaRecord.usage && typeof responseMetaRecord.usage === 'object') {
      cacheTokens = extractPromptCacheTokens(responseMetaRecord.usage as Record<string, unknown>);
    }
    if (cacheTokens !== null) {
      usage = { ...usage, prompt_cache_tokens: cacheTokens };
    }
  }

  getAiApiState(ctx).aiApiUsageResult = usage
    ? { source: 'provider', usage, ...metadata }
    : { source: 'unavailable', ...metadata };
  addAiApiUsage(ctx, usage);
  return usage;
}

export function setAiApiUsageUnavailable(ctx: Context, gatewayResponseId?: string): void {
  getAiApiState(ctx).aiApiUsageResult = {
    source: 'unavailable',
    ...(gatewayResponseId ? { gatewayResponseId } : {}),
  };
}

export function extractProviderRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const responseMetadata =
    source.response_metadata && typeof source.response_metadata === 'object'
      ? (source.response_metadata as Record<string, unknown>)
      : undefined;
  const headers =
    responseMetadata?.headers && typeof responseMetadata.headers === 'object'
      ? (responseMetadata.headers as Record<string, unknown>)
      : undefined;
  const candidate =
    responseMetadata?.request_id ??
    responseMetadata?.requestId ??
    responseMetadata?.id ??
    headers?.['x-request-id'] ??
    headers?.['request-id'];

  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
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
  const promptCount = Array.isArray(body.prompt) ? body.prompt.length : body.prompt === undefined ? undefined : 1;
  const embeddingInputCount = Array.isArray(body.input) ? body.input.length : body.input === undefined ? undefined : 1;
  const state = getAiApiState(ctx);
  const userId = state.currentUser?.id;
  if (userId === undefined || userId === null) {
    throw new Error('AI API usage record requires an authenticated NocoBase user ID.');
  }

  const oauth = state.oauthPrincipal;
  const record = await ctx.db.getRepository('aiApiUsageRecords').create({
    values: {
      requestId,
      userId,
      roleName: state.currentRole || state.currentRoles?.[0] || 'unknown',
      authType: state.aiApiAuthType || (oauth ? 'oidc' : 'unknown'),
      oauthClientId: oauth?.clientId,
      oauthSubject: oauth?.subject,
      oauthScopes: oauth?.scopes,
      endpoint,
      mode,
      model: model === '-' ? undefined : model,
      status: 'pending',
      streaming,
      startedAt: new Date(),
      requestMetadata: {
        messageCount: messages?.length,
        promptCount,
        embeddingInputCount,
        requestedMaxTokens: body.max_completion_tokens ?? body.max_tokens,
      },
    },
  });
  return record.id;
}

export async function finishUsageRecord(ctx: Context, id: unknown, startedAt: number, status: 'succeeded' | 'failed') {
  const response = (ctx.body || {}) as {
    id?: string;
    error?: { code?: string };
  };
  const state = getAiApiState(ctx);
  const streamResult = state.aiApiStreamResult;
  const usageResult = state.aiApiUsageResult ?? { source: 'unavailable' as const };
  const providerUsage = usageResult.source === 'provider' ? usageResult.usage : undefined;
  const succeeded = streamResult ? streamResult.succeeded : status === 'succeeded';
  const billing = await finalizeLlmBilling(ctx, providerUsage, succeeded);
  const usage = billing.usage ?? providerUsage;
  const gatewayResponseId = usageResult.gatewayResponseId || response.id || streamResult?.id;
  const values = {
    status: streamResult ? (streamResult.succeeded ? 'succeeded' : 'failed') : status,
    httpStatus: ctx.status,
    errorCode: response.error?.code || streamResult?.errorCode,
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    promptCacheTokens: usage?.prompt_cache_tokens ?? null,
    resolvedService: state.aiApiLlmBilling?.resolution?.service ?? null,
    resolvedProvider: state.aiApiLlmBilling?.resolution?.provider ?? null,
    resolvedModel: state.aiApiLlmBilling?.resolution?.model ?? null,
    estimatedCost: billing.estimatedCost ?? null,
    currency: billing.currency ?? null,
    costStatus: billing.costStatus ?? null,
    modelPriceId: billing.modelPriceId ?? null,
    quotaPolicyId: billing.quotaPolicyId ?? null,
    groupId: billing.groupId ?? null,
    inputPricePerMillionTokens: billing.inputPricePerMillionTokens ?? null,
    outputPricePerMillionTokens: billing.outputPricePerMillionTokens ?? null,
    fixedCostPerRequest: billing.fixedCostPerRequest ?? null,
    providerRequestId: usageResult.providerRequestId ?? null,
    completedAt: new Date(),
    durationMs: Date.now() - startedAt,
    responseMetadata: {
      usageSource: usageResult.source,
      ...(gatewayResponseId ? { gatewayResponseId } : {}),
    },
  };
  await ctx.db.getRepository('aiApiUsageRecords').update({ filterByTk: id, values });
}
