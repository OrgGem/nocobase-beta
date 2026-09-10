/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { resolveModelReference } from './resolve-service';

/**
 * Optional LLM complexity classifier for virtual-model routing.
 *
 * Keyword/length detection is English-centric (word boundaries do not exist in
 * CJK text, and stems do not transfer across languages). When an admin configures
 * `complexityClassifierModel` on a virtual model, this runs a cheap model over the
 * request text as a second opinion — but only when the fast-path already said
 * "simple", so clear-cut complex requests cost nothing extra.
 *
 * Fail-open by design: any error (unresolvable reference, disabled service,
 * missing plugin-ai, provider failure, timeout, unparseable output) returns false
 * and routing continues as if no classifier were configured.
 */

export const CLASSIFIER_MIN_TEXT_LENGTH = 20;
export const CLASSIFIER_MAX_TEXT_LENGTH = 4000;
export const CLASSIFIER_TIMEOUT_MS = 5000;

const CLASSIFIER_SYSTEM_PROMPT =
  'You classify whether a user task requires a strong reasoning model (complex planning, orchestration, analysis, ' +
  'synthesis, code architecture, migration, evaluation, or long multi-step work) or can be handled by a simple model. ' +
  'Respond with ONLY JSON: {"complex": true} or {"complex": false}.';

interface RunnableChatModel {
  invoke(messages: unknown[], params: Record<string, unknown>): Promise<unknown>;
}

interface LlmProviderInstance {
  createModel(): unknown;
}

interface LlmProviderConstructor {
  new (options: { app: unknown; serviceOptions: unknown; modelOptions: Record<string, unknown> }): LlmProviderInstance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractOutputText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!isRecord(result)) return '';
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (isRecord(block) && typeof block.text === 'string') return block.text;
        return '';
      })
      .join(' ');
  }
  return '';
}

function parseComplexFlag(text: string): boolean | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.complex === 'boolean') return parsed.complex;
  } catch {
    // Fall through to the lenient match below.
  }
  const match = /"complex"\s*:\s*(true|false)/i.exec(trimmed);
  if (match) return match[1].toLowerCase() === 'true';
  return undefined;
}

/**
 * Ask the configured cheap model whether `text` describes a complex task.
 * Returns true only on an explicit `{"complex": true}` answer; every failure
 * mode returns false so routing falls back to the normal buckets.
 */
export async function classifyComplexity(ctx: Context, classifierModelRef: string, text: string): Promise<boolean> {
  try {
    const reference = classifierModelRef.trim();
    if (!reference) return false;
    const trimmedText = text.trim();
    if (trimmedText.length < CLASSIFIER_MIN_TEXT_LENGTH) return false;

    const resolved = await resolveModelReference(ctx, reference);
    if (!resolved || resolved.service?.get?.('enabled') === false) return false;

    const aiPlugin = ctx.app.pm.get('ai') as
      | { aiManager?: { llmProviders?: Map<string, { provider: LlmProviderConstructor }> } }
      | undefined;
    const providerMeta = aiPlugin?.aiManager?.llmProviders?.get(String(resolved.service.get('provider')));
    if (!providerMeta) return false;

    const provider = new providerMeta.provider({
      app: ctx.app,
      serviceOptions: resolved.service.get('options'),
      modelOptions: {
        model: resolved.modelId,
        llmService: resolved.service.get('name'),
        temperature: 0,
        maxTokens: 20,
      },
    });
    const chatModel = provider.createModel() as RunnableChatModel;
    if (typeof chatModel?.invoke !== 'function') return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
    try {
      const result = await chatModel.invoke(
        [
          ['system', CLASSIFIER_SYSTEM_PROMPT],
          ['human', trimmedText.slice(0, CLASSIFIER_MAX_TEXT_LENGTH)],
        ],
        { signal: controller.signal },
      );
      return parseComplexFlag(extractOutputText(result)) === true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
