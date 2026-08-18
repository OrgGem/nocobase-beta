/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { getAiApiConfig } from './request-cache';

/**
 * Resolve an LLM service by name or title.
 */
export async function resolveLlmService(ctx: Context, serviceKey: string) {
  const repo = ctx.db.getRepository('llmServices');

  let service = await repo.findOne({ filter: { name: serviceKey } });
  if (!service) {
    service = await repo.findOne({ filter: { title: serviceKey } });
  }
  return service;
}

/**
 * Resolve a model string to a service + modelId.
 *
 * Strategy (priority order):
 * 1. Try splitting at each "/" position and match the left part against DB (name or title).
 *    This handles cases like "Custom LLM (OpenAI Compatible)/qwen/qwen3.6-plus-preview:free"
 * 2. If no service match, use the defaultLlmService from config and treat the ENTIRE
 *    model string as the modelId. This allows clients to send just "qwen/qwen3.6-plus-preview:free"
 *    or "gpt-4o" without knowing the service name.
 */
export async function resolveModelString(
  ctx: Context,
  modelString: string,
): Promise<{ service: any; modelId: string } | null> {
  const repo = ctx.db.getRepository('llmServices');

  // ─── Strategy 1: Try splitting at "/" positions ───
  const slashPositions: number[] = [];
  for (let i = 0; i < modelString.length; i++) {
    if (modelString[i] === '/') {
      slashPositions.push(i);
    }
  }

  if (slashPositions.length > 0) {
    for (const pos of slashPositions) {
      const serviceKey = modelString.substring(0, pos);
      const modelId = modelString.substring(pos + 1);
      if (!serviceKey || !modelId) continue;

      let service = await repo.findOne({ filter: { name: serviceKey } });
      if (!service) {
        service = await repo.findOne({ filter: { title: serviceKey } });
      }

      if (service) {
        return { service, modelId };
      }
    }
  }

  // ─── Strategy 2: Use default LLM service from config ───
  const config = await getAiApiConfig(ctx);
  if (config?.defaultLlmService) {
    const service = await repo.findOne({ filter: { name: config.defaultLlmService } });
    if (service) {
      return { service, modelId: modelString };
    }
  }

  // ─── Strategy 3: If only one service enabled, use it ───
  const enabledServices = await repo.find({ filter: { enabled: true } });
  if (enabledServices.length === 1) {
    return { service: enabledServices[0], modelId: modelString };
  }

  return null;
}
