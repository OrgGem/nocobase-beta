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
  requireNonNegativeDecimal(model.get('cacheInputPricePerMillionTokens') ?? 0, 'cacheInputPricePerMillionTokens');
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

function requireBooleanOrNull(value: unknown, field: string): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean.`);
}

function requireInteger(value: unknown, field: string): void {
  if (value === null || value === undefined || value === '') return;
  if (!Number.isSafeInteger(Number(value))) throw new Error(`${field} must be an integer.`);
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
  requireBooleanOrNull(model.get('supportsVision'), 'supportsVision');
  requireBooleanOrNull(model.get('supportsToolCalling'), 'supportsToolCalling');
  requireBooleanOrNull(model.get('enabled'), 'enabled');
  const reasoningTier = model.get('reasoningTier');
  if (
    reasoningTier !== null &&
    reasoningTier !== undefined &&
    !['cheap', 'general', 'reasoning'].includes(String(reasoningTier))
  ) {
    throw new Error('reasoningTier must be cheap, general, or reasoning.');
  }
  requireInteger(model.get('sortOrder'), 'sortOrder');

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

function requireModelReference(value: unknown, field: string): void {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const slash = normalized.indexOf('/');
  if (slash <= 0 || slash === normalized.length - 1) {
    throw new Error(`${field} must use the service/modelId format.`);
  }
}

function requireModelReferenceList(value: unknown, field: string): void {
  if (value === null || value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  value.forEach((item, index) => requireModelReference(item, `${field}[${index}]`));
}

export function validateVirtualModel(model: Model): void {
  if (!String(model.get('name') ?? '').trim()) throw new Error('name is required.');
  const mode = model.get('mode');
  if (mode !== null && mode !== undefined && !['chat', 'embedding'].includes(String(mode))) {
    throw new Error('mode must be chat or embedding.');
  }
  requireModelReference(model.get('fallbackModel'), 'fallbackModel');
  for (const field of ['visionModels', 'toolModels', 'reasoningModels', 'cheapModels', 'generalModels']) {
    requireModelReferenceList(model.get(field), field);
  }
  const complexityKeywords = model.get('complexityKeywords');
  if (complexityKeywords !== null && complexityKeywords !== undefined) {
    if (!Array.isArray(complexityKeywords)) throw new Error('complexityKeywords must be an array.');
    complexityKeywords.forEach((keyword, index) => {
      if (typeof keyword !== 'string' || !keyword.trim()) {
        throw new Error(`complexityKeywords[${index}] must be a non-empty string.`);
      }
    });
  }
  const complexityMinLength = model.get('complexityMinLength');
  if (complexityMinLength !== null && complexityMinLength !== undefined && complexityMinLength !== '') {
    const parsed = Number(complexityMinLength);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error('complexityMinLength must be a positive integer.');
    }
  }
  const complexityClassifierModel = model.get('complexityClassifierModel');
  if (
    complexityClassifierModel !== null &&
    complexityClassifierModel !== undefined &&
    String(complexityClassifierModel).trim() !== ''
  ) {
    requireModelReference(complexityClassifierModel, 'complexityClassifierModel');
  }
  requireBooleanOrNull(model.get('enabled'), 'enabled');
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
