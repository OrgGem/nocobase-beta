/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import { classifyComplexity } from './complexity-classifier';
import { toOpenAIError } from './openai-format';
import { resolveModelReference } from './resolve-service';
import { AiApiAccessScope, isModelAllowed, isServiceAllowed, resolveUserAccessScope } from './user-permissions';
import { getAiApiConfig } from './request-cache';

/**
 * Virtual-model routing ("auto" and admin-defined aliases).
 *
 * A virtual alias resolves to a concrete `service/modelId` purely from the
 * request's structural shape — never from prompt semantics (that is the
 * deliberately deferred LLM-classifier path). The resolver walks an ordered
 * bucket of candidates and picks the FIRST model the caller is permitted to
 * use; when none is usable it falls back to the configured `fallbackModel`.
 *
 * Security invariant: a candidate is only returned when it passes the caller's
 * usage-group scope (isServiceAllowed + isModelAllowed), so an alias can never
 * widen access beyond what the user could call directly.
 */

export interface VirtualModel {
  name: string;
  mode: VirtualModelMode;
  fallbackModel: string;
  visionModels?: string[];
  toolModels?: string[];
  reasoningModels?: string[];
  cheapModels?: string[];
  generalModels?: string[];
  complexityKeywords?: string[];
  complexityMinLength?: number | null;
  complexityClassifierModel?: string | null;
  enabled?: boolean;
}

export type VirtualModelMode = 'chat' | 'embedding';

export interface VirtualResolution {
  status: 'resolved';
  /** The alias the client asked for, e.g. "auto". */
  virtualModel: string;
  /** Why this bucket was chosen — recorded for audit. */
  reason: 'vision' | 'tools' | 'structured_output' | 'reasoning' | 'cheap' | 'general' | 'fallback';
  /** The resolved concrete service + modelId, ready for the existing pipeline. */
  resolved: { service: Model; modelId: string };
}

export interface UnavailableVirtualModel {
  status: 'unavailable';
  virtualModel: string;
  reason: 'mode_mismatch' | 'no_permitted_model' | 'permission_check_failed';
  configuredMode: VirtualModelMode;
  requestedMode: VirtualModelMode;
}

export type VirtualModelLookup = VirtualResolution | UnavailableVirtualModel;

interface RequestSignals {
  hasImage: boolean;
  hasTools: boolean;
  wantsStructuredOutput: boolean;
  wantsReasoning: boolean;
  hasComplexContent: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const DEFAULT_COMPLEXITY_KEYWORDS = [
  'orchestrat',
  'plan',
  'analys',
  'synthes',
  'final report',
  'final_report',
  'summary',
  'summarize',
  'strategy',
  'strategic',
  'architect',
  'design',
  'review',
  'migration',
  'roadmap',
  'decompos',
  'breakdown',
  'comparison',
  'evaluat',
  'recommend',
  'comprehensive',
  'feasib',
];

export const DEFAULT_COMPLEXITY_MIN_LENGTH = 500;

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!isRecord(block)) return '';
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
      return '';
    })
    .join(' ');
}

function collectRelevantText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts: string[] = [];
  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role : '';
    if (role && !['user', 'system', 'developer'].includes(role)) continue;
    const text = extractMessageText(msg.content);
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasComplexContentForBody(body: Record<string, unknown>, vm?: VirtualModel | null): boolean {
  const text = collectRelevantText(body);
  if (!text) return false;
  const keywords =
    vm?.complexityKeywords && vm.complexityKeywords.length > 0 ? vm.complexityKeywords : DEFAULT_COMPLEXITY_KEYWORDS;
  for (const keyword of keywords) {
    if (!keyword) continue;
    // Short keywords match only as whole words so "plan" does not fire inside "explanation"
    // or "plane"; longer keywords match as word prefixes so stems like "orchestrat" still
    // catch "orchestrating".
    const pattern = keyword.length < 6 ? `\\b${escapeRegExp(keyword)}\\b` : `\\b${escapeRegExp(keyword)}`;
    if (new RegExp(pattern, 'i').test(text)) return true;
  }
  const minLength = vm?.complexityMinLength ?? DEFAULT_COMPLEXITY_MIN_LENGTH;
  if (typeof minLength === 'number' && minLength > 0 && text.length >= minLength) return true;
  return false;
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === 'image_url') return true;
    if (block.type === 'file') return true;
    if (block.type === 'file_url') return true;
    return false;
  });
}

/** Extract the structural signals that decide the routing bucket. */
export function detectRequestSignals(body: Record<string, unknown>, vm?: VirtualModel | null): RequestSignals {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasImage = messages.some((msg) => isRecord(msg) && contentHasImage(msg.content));
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const rf = body.response_format;
  const wantsStructuredOutput = isRecord(rf) && (rf.type === 'json_object' || rf.type === 'json_schema');
  const wantsReasoning =
    (Object.hasOwn(body, 'reasoning') && body.reasoning !== undefined && body.reasoning !== null) ||
    (Object.hasOwn(body, 'reasoning_effort') && body.reasoning_effort !== undefined && body.reasoning_effort !== null);
  const hasComplexContent = hasComplexContentForBody(body, vm ?? null);
  return { hasImage, hasTools, wantsStructuredOutput, wantsReasoning, hasComplexContent };
}

function valueOf<T>(model: unknown, key: string): T | undefined {
  if (!model) return undefined;
  if (typeof (model as { get?: unknown }).get === 'function') {
    return (model as { get: (k: string) => unknown }).get(key) as T | undefined;
  }
  return (model as Record<string, unknown>)[key] as T | undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function toVirtualModel(row: unknown, fallbackName = ''): VirtualModel {
  return {
    name: String(valueOf(row, 'name') ?? fallbackName),
    mode: valueOf<string>(row, 'mode') === 'embedding' ? 'embedding' : 'chat',
    fallbackModel: String(valueOf(row, 'fallbackModel') ?? ''),
    visionModels: stringList(valueOf(row, 'visionModels')),
    toolModels: stringList(valueOf(row, 'toolModels')),
    reasoningModels: stringList(valueOf(row, 'reasoningModels')),
    cheapModels: stringList(valueOf(row, 'cheapModels')),
    generalModels: stringList(valueOf(row, 'generalModels')),
    complexityKeywords: stringList(valueOf(row, 'complexityKeywords')),
    complexityMinLength: valueOf<number | null>(row, 'complexityMinLength'),
    complexityClassifierModel: valueOf<string | null>(row, 'complexityClassifierModel'),
    enabled: valueOf<boolean>(row, 'enabled'),
  };
}

async function loadVirtualModel(ctx: Context, name: string): Promise<VirtualModel | null> {
  const row = await ctx.db.getRepository('aiApiVirtualModels').findOne({ filter: { name, enabled: true } });
  return row ? toVirtualModel(row, name) : null;
}

/**
 * Derive an ordered bucket from aiApiModelMetadata when the admin left the
 * explicit list empty: enabled rows matching the capability, ascending sortOrder.
 */
async function deriveBucket(ctx: Context, capability: 'vision' | 'tool' | 'reasoning' | 'general'): Promise<string[]> {
  const repo = ctx.db.getRepository('aiApiModelMetadata');
  const filter: Record<string, unknown> = { enabled: true };
  if (capability === 'vision') filter.supportsVision = true;
  else if (capability === 'tool') filter.supportsToolCalling = true;
  else if (capability === 'reasoning') filter.reasoningTier = 'reasoning';
  // The general bucket is a catch-all for requests with no capability signal. It intentionally
  // includes every enabled model (any reasoningTier) so a general request can be served by
  // whatever the admin ranked first via sortOrder.
  else filter.reasoningTier = { $in: ['general', 'cheap', 'reasoning'] };

  const rows = await repo.find({ filter, sort: 'sortOrder', pageSize: 200 });
  const list = (rows as unknown[]).map((row) => {
    const service = valueOf<string>(row, 'llmService');
    const model = valueOf<string>(row, 'model');
    return service && model ? `${service}/${model}` : '';
  });
  return list.filter(Boolean);
}

async function bucketFor(
  ctx: Context,
  vm: VirtualModel,
  signals: RequestSignals,
): Promise<{ reason: VirtualResolution['reason']; candidates: string[] }> {
  const explicit = (list: string[] | undefined) => (list && list.length ? list : null);
  // Deterministic structural signals first — these are unambiguous properties of
  // the request (tools array present, image blocks, explicit reasoning param).
  if (signals.hasImage) {
    return { reason: 'vision', candidates: explicit(vm.visionModels) ?? (await deriveBucket(ctx, 'vision')) };
  }
  if (signals.hasTools) {
    return { reason: 'tools', candidates: explicit(vm.toolModels) ?? (await deriveBucket(ctx, 'tool')) };
  }
  if (signals.wantsReasoning) {
    return { reason: 'reasoning', candidates: explicit(vm.reasoningModels) ?? (await deriveBucket(ctx, 'reasoning')) };
  }
  if (signals.wantsStructuredOutput) {
    return {
      reason: 'structured_output',
      candidates: explicit(vm.generalModels) ?? (await deriveBucket(ctx, 'general')),
    };
  }
  // Content-complexity heuristic is a soft signal — only used when no structural
  // signal matched. Keyword/length matching can false-positive on normal prompts.
  if (signals.hasComplexContent) {
    return { reason: 'reasoning', candidates: explicit(vm.reasoningModels) ?? (await deriveBucket(ctx, 'reasoning')) };
  }
  // Default to the cheapest bucket the admin configured; fall back to general.
  const cheap = explicit(vm.cheapModels);
  if (cheap) return { reason: 'cheap', candidates: cheap };
  return { reason: 'general', candidates: explicit(vm.generalModels) ?? (await deriveBucket(ctx, 'general')) };
}

/**
 * Resolve a virtual alias to a concrete model for the current caller.
 * Returns null when the alias does not exist or is disabled (caller then falls
 * through to the normal model resolution).
 */
export async function resolveVirtualModel(
  ctx: Context,
  alias: string,
  body: Record<string, unknown>,
  requestedMode: VirtualModelMode,
): Promise<VirtualModelLookup | null> {
  const vm = await loadVirtualModel(ctx, alias);
  if (!vm) return null;
  if (vm.mode !== requestedMode) {
    return {
      status: 'unavailable',
      virtualModel: alias,
      reason: 'mode_mismatch',
      configuredMode: vm.mode,
      requestedMode,
    };
  }

  const config = await getAiApiConfig(ctx);
  const globalServices = valueOf<unknown>(config, 'enabledLlmServices') ?? [];
  const scope = await resolveUserAccessScope(ctx);
  if (scope.lookupFailed) {
    return {
      status: 'unavailable',
      virtualModel: alias,
      reason: 'permission_check_failed',
      configuredMode: vm.mode,
      requestedMode,
    };
  }
  const usable = (service: Model, modelId: string) =>
    valueOf<boolean>(service, 'enabled') !== false &&
    isServiceAllowed(scope, globalServices, {
      name: valueOf<string>(service, 'name'),
      title: valueOf<string>(service, 'title'),
    }) &&
    isModelAllowed(scope, `${valueOf<string>(service, 'name')}/${modelId}`);

  // Embedding requests have none of the chat capability signals below. Their
  // alias is therefore a stable endpoint-family name for the configured fallback.
  if (requestedMode === 'embedding') {
    const fallback = await resolveModelReference(ctx, vm.fallbackModel);
    if (fallback && usable(fallback.service, fallback.modelId)) {
      return { status: 'resolved', virtualModel: alias, reason: 'fallback', resolved: fallback };
    }
    return {
      status: 'unavailable',
      virtualModel: alias,
      reason: 'no_permitted_model',
      configuredMode: vm.mode,
      requestedMode,
    };
  }
  const signals = detectRequestSignals(body, vm);
  // When the keyword/length fast-path says the content is simple, an optional
  // cheap LLM classifier can overrule it — useful for non-English text where
  // word-boundary matching does not apply.
  if (!signals.hasComplexContent && vm.complexityClassifierModel) {
    const text = collectRelevantText(body);
    if (await classifyComplexity(ctx, vm.complexityClassifierModel, text)) {
      signals.hasComplexContent = true;
    }
  }
  let { reason, candidates } = await bucketFor(ctx, vm, signals);

  // When content-complexity routed to reasoning but the bucket is empty (no explicit list and
  // no derived metadata), prefer the general bucket (strongest available model) over the
  // cheap fallback. The fallback remains the last resort.
  if (reason === 'reasoning' && candidates.length === 0) {
    const generalExplicit = vm.generalModels && vm.generalModels.length ? vm.generalModels : null;
    const generalCandidates = generalExplicit ?? (await deriveBucket(ctx, 'general'));
    if (generalCandidates.length > 0) {
      reason = 'general';
      candidates = generalCandidates;
    }
  }

  for (const candidate of candidates) {
    const resolved = await resolveModelReference(ctx, candidate);
    if (resolved && usable(resolved.service, resolved.modelId)) {
      return { status: 'resolved', virtualModel: alias, reason, resolved };
    }
  }

  const fallback = await resolveModelReference(ctx, vm.fallbackModel);
  if (fallback && usable(fallback.service, fallback.modelId)) {
    return { status: 'resolved', virtualModel: alias, reason: 'fallback', resolved: fallback };
  }
  return {
    status: 'unavailable',
    virtualModel: alias,
    reason: 'no_permitted_model',
    configuredMode: vm.mode,
    requestedMode,
  };
}

/** Return aliases whose required fallback model is accessible to the caller. */
export async function listAccessibleVirtualModels(
  ctx: Context,
  scope: AiApiAccessScope,
  globalServices: unknown,
): Promise<VirtualModel[]> {
  const rows = await ctx.db.getRepository('aiApiVirtualModels').find({ filter: { enabled: true } });
  const accessible: VirtualModel[] = [];

  for (const row of rows as unknown[]) {
    const vm = toVirtualModel(row);
    if (!vm.fallbackModel) continue;
    const resolved = await resolveModelReference(ctx, vm.fallbackModel);
    if (!resolved || valueOf<boolean>(resolved.service, 'enabled') === false) continue;
    const service = {
      name: valueOf<string>(resolved.service, 'name'),
      title: valueOf<string>(resolved.service, 'title'),
    };
    if (
      isServiceAllowed(scope, globalServices, service) &&
      isModelAllowed(scope, `${service.name}/${resolved.modelId}`)
    ) {
      accessible.push(vm);
    }
  }

  return accessible;
}

export function respondVirtualModelUnavailable(ctx: Context, result: UnavailableVirtualModel): void {
  if (result.reason === 'permission_check_failed') {
    ctx.status = 503;
    ctx.body = toOpenAIError(
      503,
      'Unable to verify LLM permissions for this user. Please retry shortly.',
      'service_unavailable',
      'permission_check_failed',
    );
    return;
  }
  if (result.reason === 'mode_mismatch') {
    ctx.status = 404;
    ctx.body = toOpenAIError(
      404,
      `Virtual model '${result.virtualModel}' serves ${result.configuredMode} requests and cannot be used for ${result.requestedMode} requests.`,
      'invalid_request_error',
      'model_not_found',
    );
    return;
  }
  ctx.status = 403;
  ctx.body = toOpenAIError(
    403,
    `No model behind virtual alias '${result.virtualModel}' is available to this user. Use GET /v1/models to see available models.`,
    'permission_denied',
    'model_not_available',
  );
}
