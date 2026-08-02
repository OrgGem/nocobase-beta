import { Context } from '@nocobase/actions';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { Model } from '@nocobase/database';
import type { Transaction } from 'sequelize';
import type { Usage } from './usage';

dayjs.extend(utc);
dayjs.extend(timezone);

const PRICE_SCALE = 10;
const COST_SCALE = 8;
const PRICE_TO_COST_DIVISOR = 100_000_000n;

export interface ResolvedLlmModel {
  service: Model | Record<string, unknown>;
  modelId: string;
}

export interface PriceSnapshot {
  id: string | number | bigint;
  currency: string;
  inputPricePerMillionTokens: string;
  outputPricePerMillionTokens: string;
  fixedCostPerRequest: string;
}

interface QuotaReservation {
  bucketId: string | number | bigint;
  policyId: string | number | bigint;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  reservedTokens: number;
  reservedCost: string;
  missingUsageBehavior: 'allow' | 'use_reserved';
}

export interface LlmBillingState {
  resolution?: {
    service: string;
    provider: string;
    model: string;
  };
  price?: PriceSnapshot;
  reservation?: QuotaReservation;
  providerAttempted?: boolean;
}

export interface BillingFinalization {
  usage?: Usage;
  estimatedCost?: string;
  currency?: string;
  costStatus?: 'calculated' | 'estimated' | 'unpriced' | 'usage_unavailable';
  modelPriceId?: string | number | bigint;
  quotaPolicyId?: string | number | bigint;
  inputPricePerMillionTokens?: string;
  outputPricePerMillionTokens?: string;
  fixedCostPerRequest?: string;
}

interface BillingContextState {
  aiApiLlmBilling?: LlmBillingState;
  currentUser?: { id?: string | number | bigint };
}

export class AiApiQuotaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiApiQuotaError';
  }
}

function stateOf(ctx: Context): BillingContextState {
  return ctx.state as BillingContextState;
}

function valueOf<T>(model: Model | Record<string, unknown> | null | undefined, name: string): T {
  if (!model) return undefined as T;
  if (typeof (model as Model).get === 'function') return (model as Model).get(name) as T;
  return (model as Record<string, unknown>)[name] as T;
}

function decimalString(value: unknown, scale: number): string {
  const source = String(value ?? '0').trim();
  const match = source.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`Invalid decimal value: ${source}`);
  const fraction = (match[3] ?? '').padEnd(scale, '0').slice(0, scale);
  return `${match[1]}${match[2]}.${fraction}`;
}

function decimalUnits(value: unknown, scale: number): bigint {
  return BigInt(decimalString(value, scale).replace('.', ''));
}

function formatUnits(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0');
  if (scale === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function divideRounded(value: bigint, divisor: bigint): bigint {
  return (value + divisor / 2n) / divisor;
}

function calculateCostUnits(inputTokens: number, outputTokens: number, price: PriceSnapshot): bigint {
  const input = divideRounded(
    BigInt(inputTokens) * decimalUnits(price.inputPricePerMillionTokens, PRICE_SCALE),
    PRICE_TO_COST_DIVISOR,
  );
  const output = divideRounded(
    BigInt(outputTokens) * decimalUnits(price.outputPricePerMillionTokens, PRICE_SCALE),
    PRICE_TO_COST_DIVISOR,
  );
  const fixed = divideRounded(decimalUnits(price.fixedCostPerRequest, PRICE_SCALE), 100n);
  return input + output + fixed;
}

export function calculateLlmCost(inputTokens: number, outputTokens: number, price: PriceSnapshot): string {
  return formatUnits(calculateCostUnits(inputTokens, outputTokens, price), COST_SCALE);
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function estimateInputTokens(ctx: Context): number {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const input = body.messages ?? body.prompt ?? '';
  return Math.max(1, Math.ceil(JSON.stringify(input).length / 4));
}

function getPeriodBounds(periodType: string, timezone: string): { start: Date; end: Date } {
  const unit = periodType === 'daily' ? 'day' : 'month';
  try {
    const start = dayjs()
      .tz(timezone || 'UTC')
      .startOf(unit);
    return { start: start.utc().toDate(), end: start.add(1, unit).utc().toDate() };
  } catch {
    const start = dayjs().utc().startOf(unit);
    return { start: start.toDate(), end: start.add(1, unit).toDate() };
  }
}

function exceedsIntegerLimit(current: bigint, added: bigint, limit: unknown): boolean {
  if (limit === null || limit === undefined || limit === '') return false;
  return current + added > BigInt(String(limit));
}

function exceedsDecimalLimit(current: bigint, added: bigint, limit: unknown): boolean {
  if (limit === null || limit === undefined || limit === '') return false;
  return current + added > decimalUnits(limit, COST_SCALE);
}

async function findPrice(
  ctx: Context,
  service: Model | Record<string, unknown>,
  modelId: string,
): Promise<PriceSnapshot | undefined> {
  const now = new Date();
  const price = await ctx.db.getRepository('aiApiModelPrices').findOne({
    filter: {
      llmService: valueOf<string>(service, 'name'),
      model: modelId,
      enabled: true,
      effectiveFrom: { $lte: now },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
    },
    sort: '-effectiveFrom',
  });
  if (!price) return undefined;
  return {
    id: valueOf(price, 'id'),
    currency: valueOf<string>(price, 'currency'),
    inputPricePerMillionTokens: decimalString(valueOf(price, 'inputPricePerMillionTokens'), PRICE_SCALE),
    outputPricePerMillionTokens: decimalString(valueOf(price, 'outputPricePerMillionTokens'), PRICE_SCALE),
    fixedCostPerRequest: decimalString(valueOf(price, 'fixedCostPerRequest'), PRICE_SCALE),
  };
}

export async function prepareLlmBilling(ctx: Context, resolved: ResolvedLlmModel): Promise<void> {
  const userId = stateOf(ctx).currentUser?.id;
  const serviceName = valueOf<string>(resolved.service, 'name');
  const provider = valueOf<string>(resolved.service, 'provider');
  const price = await findPrice(ctx, resolved.service, resolved.modelId);
  const billing: LlmBillingState = {
    resolution: { service: serviceName, provider, model: resolved.modelId },
    price,
  };
  stateOf(ctx).aiApiLlmBilling = billing;

  const config = await ctx.db.getRepository('aiApiConfig').findOne();
  if (!valueOf<boolean | undefined>(config, 'quotaEnabled') || userId === undefined || userId === null) return;

  const policy = await ctx.db.getRepository('aiApiUserQuotaPolicies').findOne({
    filter: { userId, enabled: true },
    sort: '-updatedAt',
  });
  if (!policy) return;

  const rejectUnpriced = valueOf<boolean>(policy, 'rejectUnpricedModel');
  if (!price && rejectUnpriced) {
    throw new AiApiQuotaError(
      'model_price_not_configured',
      `Pricing is not configured for '${serviceName}/${resolved.modelId}'.`,
    );
  }
  const policyCurrency = valueOf<string>(policy, 'currency');
  if (price && policyCurrency !== price.currency) {
    throw new AiApiQuotaError(
      'quota_currency_mismatch',
      `Quota currency '${policyCurrency}' does not match model price currency '${price.currency}'.`,
    );
  }

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const estimatedInputTokens = estimateInputTokens(ctx);
  const defaultOutput = normalizePositiveInteger(valueOf(config, 'defaultReservationOutputTokens'), 4096);
  const estimatedOutputTokens = normalizePositiveInteger(body.max_completion_tokens ?? body.max_tokens, defaultOutput);
  const reservedTokens = estimatedInputTokens + estimatedOutputTokens;
  const reservedCost = price ? calculateLlmCost(estimatedInputTokens, estimatedOutputTokens, price) : '0.00000000';
  const period = getPeriodBounds(valueOf<string>(policy, 'periodType'), valueOf<string>(policy, 'timezone'));
  const Bucket = ctx.db.getModel('aiApiUserQuotaBuckets');

  const reservation = await ctx.db.sequelize.transaction(async (transaction: Transaction) => {
    const [bucket] = await Bucket.findOrCreate({
      where: { policyId: valueOf(policy, 'id'), periodStart: period.start },
      defaults: {
        userId,
        periodEnd: period.end,
        requestCount: 0,
        totalTokens: 0,
        cost: '0.00000000',
        reservedRequests: 0,
        reservedTokens: 0,
        reservedCost: '0.00000000',
      },
      transaction,
    });
    await bucket.reload({ transaction, lock: transaction.LOCK.UPDATE });

    const requestCount = BigInt(String(bucket.get('requestCount') ?? 0));
    const reservedRequests = BigInt(String(bucket.get('reservedRequests') ?? 0));
    if (exceedsIntegerLimit(requestCount + reservedRequests, 1n, valueOf(policy, 'requestLimit'))) {
      throw new AiApiQuotaError('request_quota_exceeded', 'The request quota for this user has been exceeded.');
    }

    const totalTokens = BigInt(String(bucket.get('totalTokens') ?? 0));
    const alreadyReservedTokens = BigInt(String(bucket.get('reservedTokens') ?? 0));
    if (
      exceedsIntegerLimit(
        totalTokens + alreadyReservedTokens,
        BigInt(reservedTokens),
        valueOf(policy, 'totalTokenLimit'),
      )
    ) {
      throw new AiApiQuotaError('token_quota_exceeded', 'The token quota for this user has been exceeded.');
    }

    const cost = decimalUnits(bucket.get('cost'), COST_SCALE);
    const alreadyReservedCost = decimalUnits(bucket.get('reservedCost'), COST_SCALE);
    if (
      exceedsDecimalLimit(
        cost + alreadyReservedCost,
        decimalUnits(reservedCost, COST_SCALE),
        valueOf(policy, 'costLimit'),
      )
    ) {
      throw new AiApiQuotaError('cost_quota_exceeded', 'The cost quota for this user has been exceeded.');
    }

    await bucket.update(
      {
        reservedRequests: formatUnits(reservedRequests + 1n, 0),
        reservedTokens: formatUnits(alreadyReservedTokens + BigInt(reservedTokens), 0),
        reservedCost: formatUnits(alreadyReservedCost + decimalUnits(reservedCost, COST_SCALE), COST_SCALE),
      },
      { transaction },
    );
    return {
      bucketId: bucket.get('id') as string | number | bigint,
      policyId: valueOf<string | number | bigint>(policy, 'id'),
      estimatedInputTokens,
      estimatedOutputTokens,
      reservedTokens,
      reservedCost,
      missingUsageBehavior:
        valueOf<string>(policy, 'missingUsageBehavior') === 'allow' ? ('allow' as const) : ('use_reserved' as const),
    };
  });
  billing.reservation = reservation;
}

export function markLlmProviderAttempted(ctx: Context): void {
  const state = stateOf(ctx);
  state.aiApiLlmBilling = { ...(state.aiApiLlmBilling ?? {}), providerAttempted: true };
}

function usageNumbers(usage: Usage | undefined): { input: number; output: number; total: number } | undefined {
  if (!usage || usage.prompt_tokens === null || usage.completion_tokens === null) return undefined;
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    total: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
  };
}

export async function finalizeLlmBilling(
  ctx: Context,
  providerUsage: Usage | undefined,
  succeeded: boolean,
): Promise<BillingFinalization> {
  const billing = stateOf(ctx).aiApiLlmBilling;
  if (!billing) return {};

  let numbers = usageNumbers(providerUsage);
  let costStatus: BillingFinalization['costStatus'];
  if (numbers) {
    costStatus = billing.price ? 'calculated' : 'unpriced';
  } else if (succeeded && billing.reservation?.missingUsageBehavior === 'use_reserved') {
    numbers = {
      input: billing.reservation.estimatedInputTokens,
      output: billing.reservation.estimatedOutputTokens,
      total: billing.reservation.reservedTokens,
    };
    costStatus = billing.price ? 'estimated' : 'unpriced';
  } else {
    costStatus = billing.price ? 'usage_unavailable' : 'unpriced';
  }

  const cost = numbers && billing.price ? calculateLlmCost(numbers.input, numbers.output, billing.price) : undefined;
  const reservation = billing.reservation;
  if (reservation) {
    const Bucket = ctx.db.getModel('aiApiUserQuotaBuckets');
    await ctx.db.sequelize.transaction(async (transaction: Transaction) => {
      const bucket = await Bucket.findByPk(reservation.bucketId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!bucket) return;
      const reservedRequests = BigInt(String(bucket.get('reservedRequests') ?? 0));
      const reservedTokens = BigInt(String(bucket.get('reservedTokens') ?? 0));
      const reservedCost = decimalUnits(bucket.get('reservedCost'), COST_SCALE);
      const requestCount = BigInt(String(bucket.get('requestCount') ?? 0));
      const totalTokens = BigInt(String(bucket.get('totalTokens') ?? 0));
      const currentCost = decimalUnits(bucket.get('cost'), COST_SCALE);
      await bucket.update(
        {
          reservedRequests: formatUnits(reservedRequests > 0n ? reservedRequests - 1n : 0n, 0),
          reservedTokens: formatUnits(
            reservedTokens >= BigInt(reservation.reservedTokens)
              ? reservedTokens - BigInt(reservation.reservedTokens)
              : 0n,
            0,
          ),
          reservedCost: formatUnits(
            reservedCost >= decimalUnits(reservation.reservedCost, COST_SCALE)
              ? reservedCost - decimalUnits(reservation.reservedCost, COST_SCALE)
              : 0n,
            COST_SCALE,
          ),
          requestCount: formatUnits(requestCount + (billing.providerAttempted ? 1n : 0n), 0),
          totalTokens: formatUnits(totalTokens + BigInt(numbers?.total ?? 0), 0),
          cost: formatUnits(currentCost + decimalUnits(cost ?? '0', COST_SCALE), COST_SCALE),
        },
        { transaction },
      );
    });
  }

  return {
    usage: numbers
      ? { prompt_tokens: numbers.input, completion_tokens: numbers.output, total_tokens: numbers.total }
      : providerUsage,
    estimatedCost: cost,
    currency: billing.price?.currency,
    costStatus,
    modelPriceId: billing.price?.id,
    quotaPolicyId: reservation?.policyId,
    inputPricePerMillionTokens: billing.price?.inputPricePerMillionTokens,
    outputPricePerMillionTokens: billing.price?.outputPricePerMillionTokens,
    fixedCostPerRequest: billing.price?.fixedCostPerRequest,
  };
}
