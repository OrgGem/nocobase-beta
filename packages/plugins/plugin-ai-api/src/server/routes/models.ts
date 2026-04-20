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

    const now = Math.floor(Date.now() / 1000);
    const models: any[] = [];

    for (const service of services) {
      if (service.enabled === false) continue;

      const enabledModels = resolveEnabledModels(service);
      const serviceLabel = service.title || service.name;

      for (const model of enabledModels) {
        models.push({
          // Use "serviceName/modelId" format so the ID can be used directly in
          // POST /v1/chat/completions without ambiguity in multi-service setups.
          id: `${service.name}/${model.value}`,
          object: 'model',
          created: now,
          owned_by: serviceLabel,
        });
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
          found = {
            id: fullId,
            object: 'model',
            created: now,
            owned_by: serviceLabel,
          };
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
 * Falls back to [] if the module is unavailable or the provider has no recommendations.
 */
function getRecommendedModelsForProvider(provider: string): { label: string; value: string }[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRecommendedModels } = require('@nocobase/plugin-ai/src/common/recommended-models');
    const models = getRecommendedModels(provider);
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}
