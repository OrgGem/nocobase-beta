/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { read } from '../utils/record-utils';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

export type UsageCounts = Omit<TokenUsage, 'cost'> & { cost?: number | null };
export type UsageSource = 'actual' | 'estimated' | 'missing';
export type PricingStatus = 'configured' | 'estimated' | 'native' | 'unpriced' | 'non_usd' | 'mixed_currency';

export interface BudgetConfig {
  budgetMaxTokens?: number;
  budgetMaxCost?: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

export type PriceSnapshot = {
  inputPer1k?: number | null;
  outputPer1k?: number | null;
  cachedInputPer1k?: number | null;
  currency?: string;
  version?: string;
  source?: 'model_pricing_json' | 'legacy_global_env' | 'provider';
  status?: PricingStatus;
  cost?: number | null;
};

export type ModelCallUsageInput = {
  usageIdentity: string;
  nativeIdentity?: string;
  sessionId: string;
  messageId: string;
  usage: UsageCounts | null;
  model?: string;
  provider?: string;
  llmService?: string;
  runId?: string | number | null;
  spanId?: string | number;
  rootRunId?: string;
  parentSpanId?: string;
  role?: string;
  employeeUsername?: string;
  userId?: string | number;
  /** Trusted department snapshot captured for this exact model call. */
  departmentId?: string | number;
  source: 'ai_usage_event' | 'loop_runtime';
  priceSnapshot?: PriceSnapshot;
  nativeCost?: number | null;
  occurredAt?: Date | string | number;
  recomputeRunTotals?: boolean;
};

export type LoopInvocationUsageInput = {
  runId: string | number;
  stepId: string | number;
  sessionId: string;
  messageId?: string;
  usage: UsageCounts | null;
  input: string;
  output: string;
  role: string;
  employeeUsername: string;
  userId?: string | number;
  rootRunId?: string;
};

export type NativeUsageSyncInput = {
  sessionId: string;
  /** An invocation was made; an empty source page is incomplete rather than a free call. */
  expectEvents?: boolean;
  runId?: string | number;
  rootRunId?: string;
  parentSpanId?: string;
  role?: string;
  employeeUsername?: string;
  userId?: string | number;
};

type Repository = {
  find?: (opts: Record<string, unknown>) => Promise<unknown[]>;
  findOne?: (opts: Record<string, unknown>) => Promise<unknown>;
  create?: (opts: Record<string, unknown>) => Promise<unknown>;
  update?: (opts: Record<string, unknown>) => Promise<unknown>;
};

type UsageTransaction = { LOCK?: { UPDATE?: unknown } };
type UsageDatabase = {
  getRepository: (name: string) => Repository | undefined;
  sequelize?: {
    transaction?: <T>(operation: (transaction: UsageTransaction) => Promise<T>) => Promise<T>;
  };
};

type Rate = {
  inputPer1k: number;
  outputPer1k: number;
  cachedInputPer1k?: number;
  currency: string;
  version: string;
};

type RecordLike = Record<string, unknown>;
type LogMetadata = { module?: string; submodule?: string; method?: string; [key: string]: unknown };

const USAGE_EVENT_TYPE = 'llm_message';
const USAGE_PAGE_SIZE = 1_000;

function asRecord(value: unknown): RecordLike {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordLike) : {};
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'string' && !value.trim()) return undefined;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function readOptionalNumber(record: unknown, key: string): number | undefined {
  const raw = read(record, key);
  return readNumber(raw);
}

function identityPart(value: unknown) {
  return String(value ?? '').trim();
}

function normalizedCurrency(value: unknown) {
  const currency = identityPart(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : '';
}

function usageEventIdentity(sessionId: string, messageId: string) {
  return `ai-usage-event:${sessionId}:${messageId}`;
}

export function usageFromAIUsageEvent(event: unknown): UsageCounts | null {
  const raw = asRecord(read(event, 'rawUsageMetadata'));
  const hasRawInput = ['input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens'].some(
    (key) => Object.prototype.hasOwnProperty.call(raw, key) && readNumber(raw[key]) !== undefined,
  );
  const hasRawOutput = ['output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens'].some(
    (key) => Object.prototype.hasOwnProperty.call(raw, key) && readNumber(raw[key]) !== undefined,
  );
  const hasRawTotal = ['total_tokens', 'totalTokens'].some(
    (key) => Object.prototype.hasOwnProperty.call(raw, key) && readNumber(raw[key]) !== undefined,
  );

  const inputTokens = readOptionalNumber(event, 'inputTokens');
  const outputTokens = readOptionalNumber(event, 'outputTokens');
  const totalTokens = readOptionalNumber(event, 'totalTokens');
  if (!hasRawInput && !hasRawOutput && !hasRawTotal && inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return null;
  }
  if (inputTokens === undefined || outputTokens === undefined) return null;
  if ((!hasRawInput && inputTokens === 0) || (!hasRawOutput && outputTokens === 0)) return null;

  const cachedTokens = readOptionalNumber(event, 'cachedTokens');
  const reasoningTokens = readOptionalNumber(event, 'reasoningTokens');
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? inputTokens + outputTokens,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function usageIsValid(usage: UsageCounts | null): usage is UsageCounts {
  return Boolean(
    usage &&
      readNumber(usage.inputTokens) !== undefined &&
      readNumber(usage.outputTokens) !== undefined &&
      readNumber(usage.totalTokens) !== undefined,
  );
}

function normalizedModelKey(provider: string | undefined, model: string | undefined, llmService: string | undefined) {
  const modelName = identityPart(model).toLowerCase();
  if (!modelName) return '';
  const providerName = identityPart(provider).toLowerCase() || identityPart(llmService).toLowerCase();
  return providerName ? `${providerName}/${modelName}` : modelName;
}

function configuredRate(provider?: string, model?: string, llmService?: string): Rate | null {
  const json = process.env.ORCHESTRATOR_MODEL_PRICING_JSON;
  if (!json) return null;

  let entries: RecordLike;
  try {
    entries = asRecord(JSON.parse(json));
  } catch {
    return null;
  }

  const normalizedEntries = new Map<string, RecordLike>();
  for (const [key, value] of Object.entries(entries)) {
    normalizedEntries.set(key.trim().toLowerCase(), asRecord(value));
  }
  const modelKey = normalizedModelKey(provider, model, llmService);
  const entry =
    normalizedEntries.get(modelKey) ??
    (!provider ? normalizedEntries.get(identityPart(model).toLowerCase()) : undefined);
  if (!entry) return null;

  const inputPer1k = readNumber(entry.inputPer1k);
  const outputPer1k = readNumber(entry.outputPer1k);
  const currency = normalizedCurrency(entry.currency);
  if (inputPer1k === undefined || outputPer1k === undefined || !currency) return null;

  const cachedInputPer1k = readNumber(entry.cachedInputPer1k);
  return {
    inputPer1k,
    outputPer1k,
    ...(cachedInputPer1k === undefined ? {} : { cachedInputPer1k }),
    currency,
    version:
      identityPart(entry.version) || identityPart(process.env.ORCHESTRATOR_MODEL_PRICING_VERSION) || 'unversioned',
  };
}

function legacyGlobalRate(): Rate | null {
  const inputPer1k = readNumber(process.env.ORCHESTRATOR_PRICE_PER_1K_INPUT);
  const outputPer1k = readNumber(process.env.ORCHESTRATOR_PRICE_PER_1K_OUTPUT);
  if (inputPer1k === undefined || outputPer1k === undefined) return null;
  return {
    inputPer1k,
    outputPer1k,
    currency: 'USD',
    version: 'legacy-global-env',
  };
}

function legacyCostEstimate(inputTokens: number, outputTokens: number): number | null {
  const rate = legacyGlobalRate();
  if (!rate) return null;
  return (inputTokens / 1000) * rate.inputPer1k + (outputTokens / 1000) * rate.outputPer1k;
}

/**
 * Compatibility estimate for older callers. It only uses rates that were explicitly configured
 * through the legacy environment variables; NaN is the unpriced sentinel when no rate is set.
 */
export function estimateCost(inputTokens: number, outputTokens: number): number {
  return legacyCostEstimate(inputTokens, outputTokens) ?? Number.NaN;
}

function pricingFor(input: ModelCallUsageInput): {
  cost: number | null;
  status: PricingStatus;
  priceSource: string | null;
  snapshot: PriceSnapshot;
} {
  const supplied = input.priceSnapshot
    ? { ...input.priceSnapshot, currency: normalizedCurrency(input.priceSnapshot.currency) || undefined }
    : undefined;
  const nativeCost = readNumber(input.nativeCost) ?? readNumber(supplied?.cost);
  if (nativeCost !== undefined) {
    const currency = normalizedCurrency(supplied?.currency);
    if (currency !== 'USD') {
      const status = currency ? 'non_usd' : 'unpriced';
      return { cost: null, status, priceSource: supplied?.source ?? 'provider', snapshot: { ...supplied, status } };
    }
    return {
      cost: nativeCost,
      status: supplied?.status ?? 'native',
      priceSource: supplied?.source ?? 'provider',
      snapshot: supplied ?? { status: 'native', source: 'provider' },
    };
  }

  const suppliedInputRate = readNumber(supplied?.inputPer1k);
  const suppliedOutputRate = readNumber(supplied?.outputPer1k);
  const suppliedCachedInputRate = readNumber(supplied?.cachedInputPer1k);
  if (supplied && identityPart(supplied.currency).toUpperCase() !== 'USD') {
    const status = supplied.currency ? 'non_usd' : 'unpriced';
    return { cost: null, status, priceSource: supplied.source ?? null, snapshot: { ...supplied, status } };
  }
  if (supplied && usageIsValid(input.usage) && suppliedInputRate !== undefined && suppliedOutputRate !== undefined) {
    const cachedTokens = Math.min(input.usage.cachedTokens ?? 0, input.usage.inputTokens);
    const regularInput = input.usage.inputTokens - cachedTokens;
    const inputCost =
      suppliedCachedInputRate === undefined
        ? (input.usage.inputTokens / 1000) * suppliedInputRate
        : (regularInput / 1000) * suppliedInputRate + (cachedTokens / 1000) * suppliedCachedInputRate;
    return {
      cost: inputCost + (input.usage.outputTokens / 1000) * suppliedOutputRate,
      status: supplied.status ?? 'native',
      priceSource: supplied.source ?? 'provider',
      snapshot: supplied,
    };
  }

  const rate = configuredRate(input.provider, input.model, input.llmService);
  if (rate && rate.currency !== 'USD') {
    return {
      cost: null,
      status: 'non_usd',
      priceSource: 'model_pricing_json',
      snapshot: { ...rate, source: 'model_pricing_json', status: 'non_usd' },
    };
  }
  if (rate && usageIsValid(input.usage)) {
    const cachedTokens = Math.min(input.usage.cachedTokens ?? 0, input.usage.inputTokens);
    const regularInput = input.usage.inputTokens - cachedTokens;
    const inputCost =
      rate.cachedInputPer1k === undefined
        ? (input.usage.inputTokens / 1000) * rate.inputPer1k
        : (regularInput / 1000) * rate.inputPer1k + (cachedTokens / 1000) * rate.cachedInputPer1k;
    return {
      cost: inputCost + (input.usage.outputTokens / 1000) * rate.outputPer1k,
      status: 'configured',
      priceSource: 'model_pricing_json',
      snapshot: {
        inputPer1k: rate.inputPer1k,
        outputPer1k: rate.outputPer1k,
        ...(rate.cachedInputPer1k === undefined ? {} : { cachedInputPer1k: rate.cachedInputPer1k }),
        currency: rate.currency,
        version: rate.version,
        source: 'model_pricing_json',
        status: 'configured',
      },
    };
  }

  // The old global values remain an explicit estimate only for model-less legacy callers.
  // A known provider/model never silently inherits a global rate for another model.
  if (!input.model && !input.provider && !input.llmService && usageIsValid(input.usage)) {
    const legacyRate = legacyGlobalRate();
    const cost = legacyCostEstimate(input.usage.inputTokens, input.usage.outputTokens);
    if (legacyRate && cost !== null) {
      return {
        cost,
        status: 'estimated',
        priceSource: 'legacy_global_env',
        snapshot: {
          inputPer1k: legacyRate.inputPer1k,
          outputPer1k: legacyRate.outputPer1k,
          currency: legacyRate.currency,
          version: legacyRate.version,
          source: 'legacy_global_env',
          status: 'estimated',
        },
      };
    }
  }

  return { cost: null, status: 'unpriced', priceSource: null, snapshot: { status: 'unpriced' } };
}

function storedNumber(record: unknown, key: string): number | null {
  const value = read(record, key);
  return value === null || value === undefined || value === '' ? null : readNumber(value) ?? null;
}

function sourceDate(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return undefined;
}

function storedPriceSnapshot(record: unknown): PriceSnapshot {
  const currency = identityPart(read(record, 'priceCurrency'));
  const version = identityPart(read(record, 'priceVersion'));
  const source = identityPart(read(record, 'priceSource'));
  const status = identityPart(read(record, 'pricingStatus'));
  return {
    inputPer1k: storedNumber(record, 'priceInputPer1k'),
    outputPer1k: storedNumber(record, 'priceOutputPer1k'),
    cachedInputPer1k: storedNumber(record, 'priceCachedInputPer1k'),
    ...(currency ? { currency } : {}),
    ...(version ? { version } : {}),
    ...(source ? { source: source as PriceSnapshot['source'] } : {}),
    ...(status ? { status: status as PricingStatus } : {}),
  };
}

function sameUsage(record: unknown, usage: UsageCounts | null): boolean {
  if (!usageIsValid(usage)) return false;
  return (
    storedNumber(record, 'inputTokens') === usage.inputTokens &&
    storedNumber(record, 'outputTokens') === usage.outputTokens &&
    storedNumber(record, 'totalTokens') === usage.totalTokens &&
    storedNumber(record, 'cachedTokens') === (usage.cachedTokens ?? null) &&
    storedNumber(record, 'reasoningTokens') === (usage.reasoningTokens ?? null)
  );
}

function incompleteSessions(record: unknown): string[] {
  const value = read(record, 'usageIncompleteSessions');
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && !!entry);
  return [];
}

function spanIdentity(record: unknown) {
  const value = read(record, 'id');
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function isModelCall(record: unknown) {
  return read(record, 'type') === 'model_call';
}

function messageIdFor(event: unknown): string {
  return identityPart(read(event, 'messageId'));
}

/**
 * Tracks provider usage on model-call spans. Agent/sub-agent/tool spans remain graph projections
 * only and are never included in usage totals, avoiding parent/child double counting.
 */
export class TokenTracker {
  constructor(
    private readonly plugin: {
      app: {
        log?: { warn?: (message: string, meta?: LogMetadata) => void };
        logger?: { warn?: (message: string, meta?: LogMetadata) => void };
      };
      db: UsageDatabase;
    },
  ) {}

  get db() {
    return this.plugin.db;
  }

  get app() {
    return this.plugin.app;
  }

  private warn(message: string, error: unknown) {
    try {
      this.app.log?.warn?.(message, { error });
      this.app.logger?.warn?.(message, { error });
    } catch {
      // Telemetry logging must not affect the caller's execution.
    }
  }

  private withTransaction<T>(operation: (transaction?: UsageTransaction) => Promise<T>) {
    const sequelize = this.db.sequelize;
    return sequelize?.transaction ? sequelize.transaction((active) => operation(active)) : operation();
  }

  private async markSessionIncomplete(runId: string | number, sessionId: string, incomplete: boolean) {
    await this.withTransaction(async (transaction) => {
      const repo = this.db.getRepository('agentLoopRuns');
      if (!repo?.findOne || !repo.update) throw new Error('Run repository is unavailable.');
      const txOptions = transaction
        ? { transaction, ...(transaction.LOCK?.UPDATE === undefined ? {} : { lock: transaction.LOCK.UPDATE }) }
        : {};
      const run = await repo.findOne({ filterByTk: runId, ...txOptions });
      if (!run) throw new Error(`Run ${runId} does not exist.`);
      const sessions = new Set(incompleteSessions(run));
      if (incomplete) sessions.add(sessionId);
      else sessions.delete(sessionId);
      const currentUsageStatus = identityPart(read(run, 'usageStatus'));
      await repo.update({
        filterByTk: runId,
        values: {
          usageIncompleteSessions: [...sessions],
          ...(incomplete
            ? {
                usageStatus: currentUsageStatus && currentUsageStatus !== 'missing' ? 'partial' : 'missing',
                pricingStatus: 'unpriced',
                totalCost: null,
              }
            : {}),
        },
        ...(transaction ? { transaction } : {}),
      });
    });
  }

  /**
   * Upserts a single provider model-call usage record by its durable identity. Native usage events
   * use `ai-usage-event:<sessionId>:<messageId>`; retries and resume history therefore reconcile
   * the same row instead of adding its tokens again.
   */
  async recordModelCallUsage(input: ModelCallUsageInput): Promise<string | number | undefined> {
    const usageIdentity = identityPart(input.usageIdentity);
    if (!usageIdentity) return undefined;

    const persist = async (transaction?: UsageTransaction) => {
      const repo = this.db.getRepository('agentExecutionSpans');
      if (!repo?.create || !repo.update || !repo.findOne) return undefined;
      const txOptions = transaction
        ? { transaction, ...(transaction.LOCK?.UPDATE === undefined ? {} : { lock: transaction.LOCK.UPDATE }) }
        : {};
      const existingByIdentity = await repo.findOne({ filter: { usageIdentity }, ...txOptions });
      const existingById =
        input.spanId !== undefined ? await repo.findOne({ filterByTk: input.spanId, ...txOptions }) : null;
      const existing = existingByIdentity || (existingById && isModelCall(existingById) ? existingById : null);
      if (existing && !isModelCall(existing)) {
        this.warn('[TokenTracker] Refused to attach model-call usage to a non-model-call span.', usageIdentity);
        return undefined;
      }
      if (
        existingById &&
        !existingByIdentity &&
        identityPart(read(existingById, 'usageIdentity')) &&
        identityPart(read(existingById, 'usageIdentity')) !== usageIdentity
      ) {
        this.warn('[TokenTracker] Refused to replace a different model-call usage identity.', usageIdentity);
        return undefined;
      }

      const origin = input.source;
      const existingOrigin = identityPart(read(existing, 'usageOrigin'));
      const existingUsageSource = identityPart(read(existing, 'usageSource'));
      const hasIncomingUsage = usageIsValid(input.usage);
      const preserveNativeData =
        existingOrigin === 'ai_usage_event' &&
        (origin === 'loop_runtime' || (existingUsageSource === 'actual' && !hasIncomingUsage));
      const preserveKnownUsage =
        (existingUsageSource === 'actual' || existingUsageSource === 'estimated') && !hasIncomingUsage;
      const shouldPreserveUsage = preserveNativeData || preserveKnownUsage;
      const usage = shouldPreserveUsage ? null : input.usage;
      const usageSource: UsageSource = shouldPreserveUsage
        ? (identityPart(read(existing, 'usageSource')) as UsageSource) || 'missing'
        : usageIsValid(usage)
          ? 'actual'
          : 'missing';
      const preservePrice =
        shouldPreserveUsage || (existingUsageSource === 'actual' && sameUsage(existing, input.usage));
      const historicalSnapshot = storedPriceSnapshot(existing);
      const hasHistoricalRates = historicalSnapshot.inputPer1k != null && historicalSnapshot.outputPer1k != null;
      let resolvedPricing: ReturnType<typeof pricingFor> | null = null;
      if (!preservePrice) {
        if (hasHistoricalRates && (existingUsageSource === 'actual' || existingUsageSource === 'estimated')) {
          resolvedPricing = pricingFor({ ...input, nativeCost: undefined, priceSnapshot: historicalSnapshot });
        } else if (existingUsageSource === 'actual') {
          // Without saved unit rates a corrected quantity cannot be repriced from current prices.
          // Keep the original snapshot and mark the corrected call unpriced.
          const status = historicalSnapshot.status === 'non_usd' ? 'non_usd' : 'unpriced';
          resolvedPricing = {
            cost: null,
            status,
            priceSource: historicalSnapshot.source ?? null,
            snapshot: { ...historicalSnapshot, status },
          };
        } else {
          resolvedPricing = pricingFor(input);
        }
      }
      const now = new Date();
      const occurredAt = sourceDate(input.occurredAt) || sourceDate(read(existing, 'usageOccurredAt'));
      // Reconciliation of a native event must never replace a previously captured department.
      const existingDepartmentId = read(existing, 'departmentId');
      const departmentId = existingDepartmentId ?? input.departmentId;
      const values: RecordLike = {
        type: 'model_call',
        usageIdentity,
        ...(input.nativeIdentity ? { nativeIdentity: input.nativeIdentity } : {}),
        usageSessionId: input.sessionId,
        usageMessageId: input.messageId,
        ...(input.runId === undefined ? {} : { agentLoopRunId: input.runId }),
        ...(input.rootRunId ? { rootRunId: input.rootRunId } : {}),
        ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.employeeUsername ? { employeeUsername: input.employeeUsername } : {}),
        ...(input.userId == null ? {} : { userId: input.userId }),
        ...(departmentId == null
          ? {}
          : {
              departmentId,
              departmentAttribution:
                existingDepartmentId == null ? 'snapshot' : read(existing, 'departmentAttribution'),
            }),
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.llmService ? { llmService: input.llmService } : {}),
        source: input.source === 'ai_usage_event' ? 'native-plugin-ai' : 'loop-runtime-usage',
        usageSource,
        usageOrigin: shouldPreserveUsage ? existingOrigin || identityPart(read(existing, 'usageOrigin')) : origin,
        inputTokens: shouldPreserveUsage ? read(existing, 'inputTokens') : usage?.inputTokens ?? null,
        outputTokens: shouldPreserveUsage ? read(existing, 'outputTokens') : usage?.outputTokens ?? null,
        totalTokens: shouldPreserveUsage ? read(existing, 'totalTokens') : usage?.totalTokens ?? null,
        cachedTokens: shouldPreserveUsage ? read(existing, 'cachedTokens') : usage?.cachedTokens ?? null,
        reasoningTokens: shouldPreserveUsage ? read(existing, 'reasoningTokens') : usage?.reasoningTokens ?? null,
        cost: preservePrice ? read(existing, 'cost') : resolvedPricing?.cost ?? null,
        pricingStatus: preservePrice ? read(existing, 'pricingStatus') : resolvedPricing?.status ?? 'unpriced',
        priceSource: preservePrice ? read(existing, 'priceSource') : resolvedPricing?.priceSource ?? null,
        priceCurrency: preservePrice ? read(existing, 'priceCurrency') : resolvedPricing?.snapshot.currency ?? null,
        priceVersion: preservePrice ? read(existing, 'priceVersion') : resolvedPricing?.snapshot.version ?? null,
        priceInputPer1k: preservePrice
          ? read(existing, 'priceInputPer1k')
          : resolvedPricing?.snapshot.inputPer1k ?? null,
        priceOutputPer1k: preservePrice
          ? read(existing, 'priceOutputPer1k')
          : resolvedPricing?.snapshot.outputPer1k ?? null,
        priceCachedInputPer1k: preservePrice
          ? read(existing, 'priceCachedInputPer1k')
          : resolvedPricing?.snapshot.cachedInputPer1k ?? null,
        ...(occurredAt ? { usageOccurredAt: occurredAt } : {}),
        ...(sourceDate(input.occurredAt) ? { startedAt: occurredAt, endedAt: occurredAt } : {}),
        ...(existing
          ? {}
          : { status: 'success', startedAt: occurredAt || now, endedAt: occurredAt || now, createdAt: now }),
        updatedAt: now,
      };

      const id = spanIdentity(existing);
      if (id !== undefined) {
        await repo.update({ filterByTk: id, values, ...txOptions });
        return id;
      }

      const created = await repo.create({
        values: {
          rootRunId: input.rootRunId || `session:${input.sessionId}`,
          status: 'success',
          startedAt: occurredAt || now,
          endedAt: occurredAt || now,
          createdAt: now,
          ...values,
        },
        ...txOptions,
      });
      return spanIdentity(created);
    };

    try {
      let id: string | number | undefined;
      try {
        id = await this.withTransaction(persist);
      } catch {
        // A unique-key race aborts its transaction. Retry in a fresh transaction so the winning
        // row is re-read under lock and its actual usage/price snapshot is merged safely.
        id = await this.withTransaction(persist);
      }
      if (id === undefined) return undefined;
      if (input.runId != null && input.recomputeRunTotals !== false && !(await this.accumulateToRun(input.runId))) {
        return undefined;
      }
      return id;
    } catch (error) {
      this.warn('[TokenTracker] Failed to track model-call usage', error);
      return undefined;
    }
  }

  /**
   * Imports authoritative core aiUsageEvents for one session. The same identity is used by the
   * native monitor projection, so loop retries and observer reconciliation update one model-call.
   */
  async syncNativeUsageEvents(input: NativeUsageSyncInput): Promise<number> {
    try {
      const repo = this.db.getRepository('aiUsageEvents');
      if (!repo?.find) {
        if (input.expectEvents && input.runId != null)
          await this.markSessionIncomplete(input.runId, input.sessionId, true);
        return 0;
      }
      let tracked = 0;
      let lastMessageId: string | undefined;
      let hasMore = true;
      while (hasMore) {
        const events = await repo.find({
          filter: {
            sessionId: input.sessionId,
            eventType: USAGE_EVENT_TYPE,
            ...(lastMessageId ? { messageId: { $gt: lastMessageId } } : {}),
          },
          sort: ['messageId'],
          limit: USAGE_PAGE_SIZE,
        });
        for (const event of events) {
          const sessionId = identityPart(read(event, 'sessionId')) || input.sessionId;
          const messageId = messageIdFor(event);
          if (!messageId) throw new Error('Native usage event has no message identity.');
          const nativeCost = readNumber(read(event, 'cost'));
          const priceSnapshotValue = read(event, 'priceSnapshot');
          const priceSnapshot =
            priceSnapshotValue && typeof priceSnapshotValue === 'object'
              ? (priceSnapshotValue as PriceSnapshot)
              : undefined;
          const occurredAt = sourceDate(read(event, 'occurredAt'));
          const id = await this.recordModelCallUsage({
            usageIdentity: usageEventIdentity(sessionId, messageId),
            nativeIdentity: usageEventIdentity(sessionId, messageId),
            sessionId,
            messageId,
            usage: usageFromAIUsageEvent(event),
            model: identityPart(read(event, 'model')) || undefined,
            provider: identityPart(read(event, 'provider')) || undefined,
            llmService: identityPart(read(event, 'llmService')) || undefined,
            runId: input.runId,
            rootRunId: input.rootRunId,
            parentSpanId: input.parentSpanId,
            role: input.role,
            employeeUsername: input.employeeUsername || identityPart(read(event, 'aiEmployeeUsername')) || undefined,
            userId: input.userId ?? (read(event, 'userId') as string | number | undefined),
            source: 'ai_usage_event',
            recomputeRunTotals: false,
            ...(occurredAt ? { occurredAt } : {}),
            ...(priceSnapshot ? { priceSnapshot } : {}),
            ...(nativeCost === undefined ? {} : { nativeCost }),
          });
          if (id === undefined) throw new Error(`Could not persist usage event ${messageId}.`);
          tracked += 1;
        }
        if (events.length < USAGE_PAGE_SIZE) {
          hasMore = false;
          continue;
        }
        const nextMessageId = messageIdFor(events[events.length - 1]);
        if (!nextMessageId || nextMessageId === lastMessageId)
          throw new Error('Native usage pagination did not advance.');
        lastMessageId = nextMessageId;
      }
      if (input.runId != null && (tracked > 0 || input.expectEvents)) {
        // An empty query cannot prove an invocation consumed no tokens. Retain a previous
        // incomplete marker until at least one source event can be fully reconciled.
        await this.markSessionIncomplete(input.runId, input.sessionId, tracked === 0);
        if (!(await this.accumulateToRun(input.runId))) throw new Error('Could not recalculate usage totals.');
      }
      return tracked;
    } catch (error) {
      this.warn('[TokenTracker] Failed to synchronize native usage events', error);
      if (input.runId != null) {
        try {
          await this.markSessionIncomplete(input.runId, input.sessionId, true);
        } catch (markError) {
          this.warn('[TokenTracker] Failed to mark incomplete run usage', markError);
        }
      }
      return -1;
    }
  }

  /**
   * Persists the loop adapter's transcript aggregate only as a non-additive summary when the
   * authoritative aiUsageEvents rows are unavailable. Summary rows stay out of run totals so a
   * later native reconciliation cannot double-count resume history or model-call children.
   */
  async trackLoopInvocationUsage(input: LoopInvocationUsageInput): Promise<void> {
    const nativeRows = await this.syncNativeUsageEvents({
      sessionId: input.sessionId,
      expectEvents: true,
      runId: input.runId,
      rootRunId: input.rootRunId,
      role: input.role,
      employeeUsername: input.employeeUsername,
      userId: input.userId,
    });
    if (nativeRows !== 0) return;

    try {
      const repo = this.db.getRepository('agentExecutionSpans');
      if (!repo?.findOne || !repo?.create || !repo.update) return;
      const usageIdentity = `loop-invocation-summary:${input.runId}:${input.stepId}`;
      const existing = await repo.findOne({ filter: { usageIdentity } });
      const now = new Date();
      let usage: UsageCounts | null = usageIsValid(input.usage) ? input.usage : null;
      let source: UsageSource = usage ? 'actual' : 'missing';
      if (!usage) {
        const inputTokens = Math.ceil((input.input || '').length / 4);
        const outputTokens = Math.ceil((input.output || '').length / 4);
        usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
        source = 'estimated';
      }
      const priced = pricingFor({
        usageIdentity,
        sessionId: input.sessionId,
        messageId: input.messageId || '',
        usage,
        source: 'loop_runtime',
      });
      const values: RecordLike = {
        type: 'invocation_summary',
        usageIdentity,
        usageSessionId: input.sessionId,
        usageMessageId: input.messageId || null,
        agentLoopRunId: input.runId,
        agentLoopStepId: input.stepId,
        rootRunId: input.rootRunId || `loop:${input.runId}`,
        role: input.role,
        employeeUsername: input.employeeUsername,
        ...(input.userId == null ? {} : { userId: input.userId }),
        source: 'loop-runtime-summary',
        usageSource: source,
        usageOrigin: 'loop_invocation_summary',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cachedTokens: usage.cachedTokens ?? null,
        reasoningTokens: usage.reasoningTokens ?? null,
        cost: priced.cost,
        pricingStatus: priced.cost === null ? 'unpriced' : source === 'estimated' ? 'estimated' : priced.status,
        priceSource: priced.priceSource,
        priceCurrency: priced.snapshot.currency ?? null,
        priceVersion: priced.snapshot.version ?? null,
        priceInputPer1k: priced.snapshot.inputPer1k ?? null,
        priceOutputPer1k: priced.snapshot.outputPer1k ?? null,
        priceCachedInputPer1k: priced.snapshot.cachedInputPer1k ?? null,
        status: 'success',
        startedAt: now,
        endedAt: now,
        updatedAt: now,
      };
      const existingId = spanIdentity(existing);
      if (existingId !== undefined) {
        await repo.update({ filterByTk: existingId, values });
      } else {
        await repo.create({ values: { createdAt: now, ...values } });
      }
    } catch (error) {
      this.warn('[TokenTracker] Failed to persist loop invocation usage summary', error);
    }
  }

  /**
   * Compatibility API for callers that already hold an agentExecutionSpans primary key. This
   * method deliberately keeps span identity separate from agentLoopSteps IDs.
   */
  async trackSpan(spanId: string | number | undefined, usage: TokenUsage, runId?: string | number): Promise<void> {
    if (spanId === undefined || spanId === null || spanId === '') return;

    try {
      const repo = this.db.getRepository('agentExecutionSpans');
      if (!repo?.findOne || !repo.update) return;
      const span = await repo.findOne({ filterByTk: spanId });
      if (!span) return;
      const inputTokens = readNumber(usage.inputTokens);
      const outputTokens = readNumber(usage.outputTokens);
      const totalTokens = readNumber(usage.totalTokens);
      if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return;

      const model = identityPart(read(span, 'model')) || undefined;
      const provider = identityPart(read(span, 'provider')) || undefined;
      const llmService = identityPart(read(span, 'llmService')) || undefined;
      const resolved = pricingFor({
        usageIdentity: identityPart(read(span, 'usageIdentity')) || `legacy-span:${spanId}`,
        nativeIdentity: identityPart(read(span, 'nativeIdentity')) || undefined,
        sessionId: identityPart(read(span, 'sessionId')),
        messageId: identityPart(read(span, 'messageId')),
        usage: { inputTokens, outputTokens, totalTokens, cost: usage.cost, cachedTokens: usage.cachedTokens },
        model,
        provider,
        llmService,
        source: 'loop_runtime',
      });
      await repo.update({
        filterByTk: spanId,
        values: {
          inputTokens,
          outputTokens,
          totalTokens,
          cachedTokens: usage.cachedTokens ?? null,
          reasoningTokens: usage.reasoningTokens ?? null,
          usageSource: 'actual',
          usageOrigin: 'legacy_tracker',
          cost: resolved.cost,
          pricingStatus: resolved.status,
          priceSource: resolved.priceSource,
          priceCurrency: resolved.snapshot.currency ?? null,
          priceVersion: resolved.snapshot.version ?? null,
          priceInputPer1k: resolved.snapshot.inputPer1k ?? null,
          priceOutputPer1k: resolved.snapshot.outputPer1k ?? null,
          priceCachedInputPer1k: resolved.snapshot.cachedInputPer1k ?? null,
          updatedAt: new Date(),
        },
      });

      if (runId != null) await this.accumulateToRun(runId);
    } catch (error) {
      this.warn('[TokenTracker] Failed to track span tokens', error);
    }
  }

  /** Recalculates totals from model-call spans only. Parent and child span tokens are not added. */
  async accumulateToRun(runId: string | number): Promise<boolean> {
    try {
      return await this.withTransaction(async (transaction) => {
        const spansRepo = this.db.getRepository('agentExecutionSpans');
        const runsRepo = this.db.getRepository('agentLoopRuns');
        if (!spansRepo?.find || !runsRepo?.findOne || !runsRepo.update) return false;
        const txOptions = transaction
          ? { transaction, ...(transaction.LOCK?.UPDATE === undefined ? {} : { lock: transaction.LOCK.UPDATE }) }
          : {};
        // All writers recomputing a run acquire the same row lock before reading its spans.
        // A later writer therefore includes every model-call committed by earlier writers.
        const run = await runsRepo.findOne({ filterByTk: runId, ...txOptions });
        if (!run) return false;

        let totalInput = 0;
        let totalOutput = 0;
        let totalTokens = 0;
        let totalCost = 0;
        let hasKnownUsage = false;
        let hasMissingUsage = incompleteSessions(run).length > 0;
        let hasEstimatedUsage = false;
        let hasActualUsage = false;
        let hasUnpriced = incompleteSessions(run).length > 0;
        let hasNonUsd = false;
        let hasEstimatedPrice = false;
        let rowCount = 0;
        let lastId: string | number | undefined;

        let hasMore = true;
        while (hasMore) {
          const spans = await spansRepo.find({
            filter: {
              agentLoopRunId: runId,
              type: 'model_call',
              ...(lastId === undefined ? {} : { id: { $gt: lastId } }),
            },
            fields: [
              'id',
              'inputTokens',
              'outputTokens',
              'totalTokens',
              'cost',
              'usageSource',
              'pricingStatus',
              'priceCurrency',
            ],
            sort: ['id'],
            limit: USAGE_PAGE_SIZE,
            ...(transaction ? { transaction } : {}),
          });
          rowCount += spans.length;
          for (const span of spans) {
            const source = identityPart(read(span, 'usageSource'));
            const inputTokens = storedNumber(span, 'inputTokens');
            const outputTokens = storedNumber(span, 'outputTokens');
            const storedTotalTokens = storedNumber(span, 'totalTokens');
            if (source === 'missing' || inputTokens === null || outputTokens === null) {
              hasMissingUsage = true;
            } else {
              hasKnownUsage = true;
              totalInput += inputTokens;
              totalOutput += outputTokens;
              totalTokens += storedTotalTokens ?? inputTokens + outputTokens;
              if (source === 'estimated' || !source) hasEstimatedUsage = true;
              if (source === 'actual') hasActualUsage = true;
            }

            const pricingStatus = identityPart(read(span, 'pricingStatus'));
            const currency = identityPart(read(span, 'priceCurrency')).toUpperCase();
            const cost = storedNumber(span, 'cost');
            if (pricingStatus === 'non_usd' || (currency && currency !== 'USD')) hasNonUsd = true;
            if (pricingStatus === 'unpriced' || cost === null || currency !== 'USD') {
              hasUnpriced = true;
            } else {
              totalCost += cost;
              if (pricingStatus === 'estimated') hasEstimatedPrice = true;
            }
          }
          if (spans.length < USAGE_PAGE_SIZE) {
            hasMore = false;
            continue;
          }
          const nextId = spanIdentity(spans[spans.length - 1]);
          if (nextId === undefined || nextId === lastId) throw new Error('Usage rollup pagination did not advance.');
          lastId = nextId;
        }

        const usageStatus = !hasKnownUsage
          ? 'missing'
          : hasMissingUsage
            ? 'partial'
            : hasEstimatedUsage
              ? 'estimated'
              : hasActualUsage
                ? 'actual'
                : 'partial';
        const pricingStatus = hasNonUsd
          ? 'non_usd'
          : hasUnpriced || rowCount === 0
            ? 'unpriced'
            : hasEstimatedPrice
              ? 'estimated'
              : 'configured';
        await runsRepo.update({
          filterByTk: runId,
          values: {
            totalInputTokens: hasKnownUsage ? totalInput : null,
            totalOutputTokens: hasKnownUsage ? totalOutput : null,
            totalTokens: hasKnownUsage ? totalTokens : null,
            totalCost: hasUnpriced || rowCount === 0 ? null : totalCost,
            usageStatus,
            pricingStatus,
          },
          ...(transaction ? { transaction } : {}),
        });
        return true;
      });
    } catch (error) {
      this.warn('[TokenTracker] Failed to accumulate run totals', error);
      return false;
    }
  }

  /** Checks configured budgets. Unknown cost is never treated as a free run. */
  async checkBudget(runId: string | number): Promise<BudgetCheckResult> {
    try {
      const repo = this.db.getRepository('agentLoopRuns');
      if (!repo?.findOne) return { allowed: true };

      const run = await repo.findOne({ filter: { id: runId } });
      if (!run) return { allowed: true };

      const budgetMaxTokens = Number(read(run, 'budgetMaxTokens') ?? 0);
      const budgetMaxCost = Number(read(run, 'budgetMaxCost') ?? 0);
      if (budgetMaxTokens <= 0 && budgetMaxCost <= 0) return { allowed: true };

      const usageStatus = identityPart(read(run, 'usageStatus'));
      const pricingStatus = identityPart(read(run, 'pricingStatus'));
      const hasIncompleteSessions = incompleteSessions(run).length > 0;
      const totalTokens = readNumber(read(run, 'totalTokens'));
      const totalCost = readNumber(read(run, 'totalCost'));
      const hasInvocations = (readNumber(read(run, 'invocationCount')) ?? 0) > 0;

      if (
        budgetMaxTokens > 0 &&
        (hasIncompleteSessions ||
          usageStatus === 'partial' ||
          usageStatus === 'missing' ||
          (totalTokens === undefined && (usageStatus !== '' || hasInvocations)))
      ) {
        return {
          allowed: false,
          reason: 'Token usage is unavailable, so this run cannot be checked against its token budget.',
        };
      }
      if (
        budgetMaxCost > 0 &&
        (hasIncompleteSessions ||
          pricingStatus === 'unpriced' ||
          pricingStatus === 'non_usd' ||
          (totalCost === undefined && (pricingStatus !== '' || hasInvocations)))
      ) {
        return {
          allowed: false,
          reason: 'Model pricing is unavailable, so this run cannot be checked against its cost budget.',
        };
      }
      if (budgetMaxTokens > 0 && totalTokens !== undefined && totalTokens >= budgetMaxTokens) {
        return {
          allowed: false,
          reason: `Budget exceeded: ${totalTokens}/${budgetMaxTokens} tokens used. Maximum allowed tokens for this run: ${budgetMaxTokens}.`,
        };
      }
      if (budgetMaxCost > 0 && totalCost !== undefined && totalCost >= budgetMaxCost) {
        return {
          allowed: false,
          reason: `Budget exceeded: $${totalCost.toFixed(4)}/$${budgetMaxCost.toFixed(
            4,
          )} spent. Maximum allowed cost for this run: $${budgetMaxCost}.`,
        };
      }

      return { allowed: true };
    } catch (error) {
      this.warn('[TokenTracker] Budget check failed, allowing', error);
      return { allowed: true };
    }
  }

  /**
   * Compatibility API for callers that update an existing span. Missing usage falls back to an
   * explicit text estimate; zero-token actual usage remains actual and is never re-estimated.
   */
  async trackActualUsage(
    spanId: string | number | undefined,
    tokenUsage: UsageCounts | null,
    input: string,
    output: string,
    runId?: string | number,
  ): Promise<void> {
    if (usageIsValid(tokenUsage)) {
      await this.trackSpan(spanId, { ...tokenUsage, cost: tokenUsage.cost ?? Number.NaN }, runId);
      return;
    }
    await this.estimateAndTrack(spanId, input, output, runId);
  }

  /** Stores the legacy text-length estimate explicitly, scoped to an existing span. */
  async estimateAndTrack(
    spanId: string | number | undefined,
    input: string,
    output: string,
    runId?: string | number,
  ): Promise<void> {
    if (spanId === undefined || spanId === null || spanId === '') return;
    try {
      const repo = this.db.getRepository('agentExecutionSpans');
      if (!repo?.findOne || !repo.update) return;
      const span = await repo.findOne({ filterByTk: spanId });
      if (!span) return;
      const inputTokens = Math.ceil((input || '').length / 4);
      const outputTokens = Math.ceil((output || '').length / 4);
      const usage: UsageCounts = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
      const resolved = pricingFor({
        usageIdentity: identityPart(read(span, 'usageIdentity')) || `legacy-span:${spanId}`,
        sessionId: identityPart(read(span, 'sessionId')),
        messageId: identityPart(read(span, 'messageId')),
        usage,
        model: identityPart(read(span, 'model')) || undefined,
        provider: identityPart(read(span, 'provider')) || undefined,
        llmService: identityPart(read(span, 'llmService')) || undefined,
        source: 'loop_runtime',
      });
      await repo.update({
        filterByTk: spanId,
        values: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cachedTokens: null,
          reasoningTokens: null,
          usageSource: 'estimated',
          usageOrigin: 'text_length_estimate',
          cost: resolved.cost,
          pricingStatus: resolved.cost === null ? 'unpriced' : 'estimated',
          priceSource: resolved.priceSource,
          priceCurrency: resolved.snapshot.currency ?? null,
          priceVersion: resolved.snapshot.version ?? null,
          priceInputPer1k: resolved.snapshot.inputPer1k ?? null,
          priceOutputPer1k: resolved.snapshot.outputPer1k ?? null,
          priceCachedInputPer1k: resolved.snapshot.cachedInputPer1k ?? null,
          updatedAt: new Date(),
        },
      });
      if (runId != null) await this.accumulateToRun(runId);
    } catch (error) {
      this.warn('[TokenTracker] Failed to estimate span tokens', error);
    }
  }
}

export { usageEventIdentity };
