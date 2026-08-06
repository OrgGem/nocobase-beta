/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { toOpenAIError } from '../utils/openai-format';
import type PluginAiApiServer from '../plugin';

/**
 * GET /api/ai-llm/v1/models
 *
 * Lists all available models from enabled LLM services.
 * Model IDs use the "serviceName/modelId" format (e.g. "my-openai/gpt-4o")
 * so clients can copy-paste the ID directly into POST /v1/chat/completions
 * without needing to configure a defaultLlmService.
 *
 * Backward compatibility: resolveModelString() in resolve-service.ts still
 * accepts bare model IDs via its 3-tier fallback (defaultLlmService / single service).
 */
export async function handleListModels(ctx: Context, plugin: PluginAiApiServer) {
  try {
    const aiPlugin = ctx.app.pm.get('ai') as any;
    if (!aiPlugin) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, 'AI plugin not available', 'server_error');
      return;
    }

    const config = await getPluginConfig(ctx);
    const filter: any = {};

    // If whitelist is set, apply it (match by name OR title)
    if (config?.enabledLlmServices?.length) {
      filter.$or = [{ name: { $in: config.enabledLlmServices } }, { title: { $in: config.enabledLlmServices } }];
    }

    const services = await ctx.db.getRepository('llmServices').find({
      filter,
      sort: 'sort',
    });

    const metadataMap = await loadModelMetadata(ctx);
    const now = Math.floor(Date.now() / 1000);
    const models: any[] = [];

    for (const service of services) {
      if (service.enabled === false) continue;

      const enabledModels = resolveEnabledModels(service);
      const serviceLabel = service.title || service.name;

      for (const model of enabledModels) {
        const fullId = `${service.name}/${model.value}`;
        const meta = metadataMap.get(fullId);
        // An override row with enabled=false hides the model from the catalog.
        if (meta && meta.enabled === false) continue;
        models.push(buildModelObject(fullId, now, serviceLabel, meta));
      }
    }

    ctx.status = 200;
    ctx.body = {
      object: 'list',
      data: models,
    };
  } catch (err) {
    ctx.log.error('AI API list models error:', err);
    ctx.status = 500;
    ctx.body = toOpenAIError(500, 'Failed to list models', 'server_error');
  }
}

/**
 * GET /api/ai-llm/v1/models/:model
 *
 * Retrieve a single model by ID.
 * Accepts both "serviceName/modelId" format (new) and bare "modelId" (backward compat).
 */
export async function handleGetModel(ctx: Context, modelId: string, plugin: PluginAiApiServer) {
  try {
    const config = await getPluginConfig(ctx);
    const filter: any = {};

    if (config?.enabledLlmServices?.length) {
      filter.$or = [{ name: { $in: config.enabledLlmServices } }, { title: { $in: config.enabledLlmServices } }];
    }

    const services = await ctx.db.getRepository('llmServices').find({
      filter,
      sort: 'sort',
    });

    const metadataMap = await loadModelMetadata(ctx);
    const now = Math.floor(Date.now() / 1000);
    let found: any = null;

    for (const service of services) {
      if (service.enabled === false) continue;
      const enabledModels = resolveEnabledModels(service);
      const serviceLabel = service.title || service.name;

      for (const model of enabledModels) {
        const fullId = `${service.name}/${model.value}`;
        // Accept both new "serviceName/modelId" format AND bare model ID (backward compat)
        if (fullId === modelId || model.value === modelId) {
          const meta = metadataMap.get(fullId);
          // A disabled override hides the model — treat as not found.
          if (meta && meta.enabled === false) continue;
          found = buildModelObject(fullId, now, serviceLabel, meta);
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      ctx.status = 404;
      ctx.body = toOpenAIError(404, `Model '${modelId}' not found`, 'invalid_request_error', 'model_not_found');
      return;
    }

    ctx.status = 200;
    ctx.body = found;
  } catch (err) {
    ctx.log.error('AI API get model error:', err);
    ctx.status = 500;
    ctx.body = toOpenAIError(500, 'Failed to retrieve model', 'server_error');
  }
}

// ─── Helpers ───

export interface ModelMetadataOverride {
  contextWindow?: number | null;
  maxCompletionTokens?: number | null;
  ownedByOverride?: string | null;
  displayName?: string | null;
  description?: string | null;
  enabled?: boolean;
}

/**
 * Load all model metadata overrides keyed by "serviceName/modelId".
 * Returns an empty map if the collection is unavailable (e.g. mid-migration).
 */
async function loadModelMetadata(ctx: Context): Promise<Map<string, ModelMetadataOverride>> {
  const map = new Map<string, ModelMetadataOverride>();
  try {
    const rows = await ctx.db.getRepository('aiApiModelMetadata').find();
    for (const row of rows) {
      const service = row.get('llmService');
      const model = row.get('model');
      if (!service || !model) continue;
      map.set(`${service}/${model}`, {
        contextWindow: row.get('contextWindow'),
        maxCompletionTokens: row.get('maxCompletionTokens'),
        ownedByOverride: row.get('ownedByOverride'),
        displayName: row.get('displayName'),
        description: row.get('description'),
        enabled: row.get('enabled'),
      });
    }
  } catch (err) {
    ctx.log?.warn?.('AI API model metadata unavailable, skipping overrides:', err);
  }
  return map;
}

/**
 * Build an OpenAI-compatible model object, merging any admin override.
 *
 * Context window is emitted under BOTH keys for maximum client compatibility:
 *   - `context_window`  (Groq / most OpenAI-compatible gateways)
 *   - `context_length`  (OpenRouter and its consumers)
 * Both carry the same value so a client reading either key sees the override.
 */
export function buildModelObject(
  fullId: string,
  created: number,
  serviceLabel: string,
  meta?: ModelMetadataOverride,
): Record<string, unknown> {
  const model: Record<string, unknown> = {
    id: fullId,
    object: 'model',
    created,
    owned_by: meta?.ownedByOverride || serviceLabel,
  };

  const contextWindow = toPositiveInt(meta?.contextWindow);
  if (contextWindow !== null) {
    model.context_window = contextWindow;
    model.context_length = contextWindow;
  }
  const maxCompletionTokens = toPositiveInt(meta?.maxCompletionTokens);
  if (maxCompletionTokens !== null) {
    model.max_completion_tokens = maxCompletionTokens;
  }
  if (meta?.displayName) {
    model.display_name = meta.displayName;
    model.name = meta.displayName;
  }
  if (meta?.description) {
    model.description = meta.description;
  }
  // Only surface `active` when an override row exists; a plain model stays
  // implicitly active (matching the previous response shape).
  if (meta) {
    model.active = meta.enabled !== false;
  }

  return model;
}

function toPositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function getPluginConfig(ctx: Context) {
  return ctx.db.getRepository('aiApiConfig').findOne();
}

/**
 * Resolve enabled models for a service.
 * Mirrors the logic from plugin-ai's ai.ts listAllEnabledModels.
 *
 * For 'recommended' mode, we now correctly fetch the official model list
 * from plugin-ai's shared recommended-models module.
 */
function resolveEnabledModels(service: any): { label: string; value: string }[] {
  const raw = service.enabledModels;

  // Handle new { mode, models } format
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.mode) {
    if (raw.mode === 'recommended') {
      return getRecommendedModelsForProvider(service.provider);
    }
    // 'provider' or 'custom' mode with explicitly listed models
    return (raw.models || [])
      .filter((m: any) => m.value)
      .map((m: any) => ({ label: m.label || m.value, value: m.value }));
  }

  // Backward compat: old string[] format
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      // Empty array means no explicit models — fall back to recommended
      return getRecommendedModelsForProvider(service.provider);
    }
    return raw.map((id: string) => ({ label: id, value: id }));
  }

  // null/undefined — no explicit models set, fall back to recommended
  return getRecommendedModelsForProvider(service.provider);
}

/**
 * Get recommended models for a provider from plugin-ai's shared module.
 *
 * Uses dynamic require() to avoid a hard compile-time import path dependency.
 * plugin-ai is always available at runtime (it's a peerDependency).
 *
 * Resolves the built `dist/` module first — that is what ships in a packed
 * plugin (package.json `main` points at `dist/`, and `src/` is not published).
 * Falls back to `src/` for the monorepo dev runtime where only sources exist.
 * Falls back to [] if neither is available or the provider has no recommendations.
 */
function getRecommendedModelsForProvider(provider: string): { label: string; value: string }[] {
  const modulePaths = [
    '@nocobase/plugin-ai/dist/common/recommended-models',
    '@nocobase/plugin-ai/src/common/recommended-models',
  ];
  for (const modulePath of modulePaths) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getRecommendedModels } = require(modulePath);
      const models = getRecommendedModels(provider);
      return Array.isArray(models) ? models : [];
    } catch {
      // Try the next candidate path.
    }
  }
  return [];
}
