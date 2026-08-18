import dayjs from 'dayjs';
import type { Database, Model } from '@nocobase/database';

function requireNonNegativeDecimal(value: unknown, field: string): void {
  const normalized = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`${field} must be a non-negative decimal.`);
  }
}

function requireNonNegativeIntegerOrNull(value: unknown, field: string): void {
  if (value === null || value === undefined || value === '') return;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer.`);
}

export async function validateModelPrice(db: Database, model: Model): Promise<void> {
  requireNonNegativeDecimal(model.get('inputPricePerMillionTokens'), 'inputPricePerMillionTokens');
  requireNonNegativeDecimal(model.get('outputPricePerMillionTokens'), 'outputPricePerMillionTokens');
  requireNonNegativeDecimal(model.get('fixedCostPerRequest') ?? 0, 'fixedCostPerRequest');

  const effectiveFrom = new Date(String(model.get('effectiveFrom')));
  const effectiveToValue = model.get('effectiveTo');
  const effectiveTo = effectiveToValue ? new Date(String(effectiveToValue)) : undefined;
  if (Number.isNaN(effectiveFrom.getTime())) throw new Error('effectiveFrom must be a valid date.');
  if (effectiveTo && (Number.isNaN(effectiveTo.getTime()) || effectiveTo <= effectiveFrom)) {
    throw new Error('effectiveTo must be later than effectiveFrom.');
  }
  if (model.get('enabled') === false) return;

  const overlapFilter: Record<string, unknown> = {
    llmService: model.get('llmService'),
    model: model.get('model'),
    enabled: true,
    effectiveFrom: { $lt: effectiveTo ?? new Date('9999-12-31T23:59:59.999Z') },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: effectiveFrom } }],
  };
  if (model.get('id')) overlapFilter.id = { $ne: model.get('id') };
  const overlap = await db.getRepository('aiApiModelPrices').findOne({
    filter: overlapFilter,
  });
  if (overlap) throw new Error('An enabled price already overlaps this effective period.');
}

function requirePositiveIntegerOrNull(value: unknown, field: string): void {
  if (value === null || value === undefined || value === '') return;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer.`);
}

export function validateModelMetadata(model: Model): void {
  if (!String(model.get('llmService') ?? '').trim()) throw new Error('llmService is required.');
  if (!String(model.get('model') ?? '').trim()) throw new Error('model is required.');
  requirePositiveIntegerOrNull(model.get('contextWindow'), 'contextWindow');
  requirePositiveIntegerOrNull(model.get('maxCompletionTokens'), 'maxCompletionTokens');
  const systemPrompt = model.get('systemPrompt');
  if (systemPrompt !== null && systemPrompt !== undefined && typeof systemPrompt !== 'string') {
    throw new Error('systemPrompt must be a string.');
  }

  const contextWindow = model.get('contextWindow');
  const maxCompletionTokens = model.get('maxCompletionTokens');
  if (
    contextWindow !== null &&
    contextWindow !== undefined &&
    contextWindow !== '' &&
    maxCompletionTokens !== null &&
    maxCompletionTokens !== undefined &&
    maxCompletionTokens !== '' &&
    Number(maxCompletionTokens) > Number(contextWindow)
  ) {
    throw new Error('maxCompletionTokens cannot exceed contextWindow.');
  }
}

export function validateQuotaPolicy(model: Model): void {
  if (!['daily', 'monthly'].includes(String(model.get('periodType')))) {
    throw new Error('periodType must be daily or monthly.');
  }
  if (!['share', 'per_user'].includes(String(model.get('quotaMode')))) {
    throw new Error('quotaMode must be share or per_user.');
  }
  if (!['allow', 'use_reserved'].includes(String(model.get('missingUsageBehavior')))) {
    throw new Error('missingUsageBehavior must be allow or use_reserved.');
  }
  if (!['reject', 'truncate'].includes(String(model.get('contextOverflowBehavior') ?? 'reject'))) {
    throw new Error('contextOverflowBehavior must be reject or truncate.');
  }
  try {
    dayjs().tz(String(model.get('timezone') || 'UTC'));
  } catch {
    throw new Error('timezone must be a valid IANA timezone.');
  }
  requireNonNegativeIntegerOrNull(model.get('requestLimit'), 'requestLimit');
  requireNonNegativeIntegerOrNull(model.get('totalTokenLimit'), 'totalTokenLimit');
  if (model.get('costLimit') !== null && model.get('costLimit') !== undefined) {
    requireNonNegativeDecimal(model.get('costLimit'), 'costLimit');
  }
}
