/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { checkUrlAgainstWhitelist } from '@nocobase/utils';

// Local stubs for types not publicly exported from @nocobase/plugin-ai.
// These mirror the minimal runtime shape needed by CustomEmbeddingProvider,
// including the SSRF whitelist check and env-template rendering applied by
// the upstream EmbeddingProvider. Keep in sync with the upstream
// definitions in that package (server/llm-providers/provider.ts).

export enum SupportedModel {
  LLM = 'LLM',
  EMBEDDING = 'EMBEDDING',
}

function assertBaseURLString(baseURL: unknown): asserts baseURL is string {
  if (typeof baseURL !== 'string') {
    throw new Error('baseURL must be a string');
  }
}

function normalizeBaseURL(baseURL: unknown): string {
  assertBaseURLString(baseURL);
  const trimmedBaseURL = baseURL.trim();
  checkUrlAgainstWhitelist(trimmedBaseURL);
  return new URL(trimmedBaseURL).toString().replace(/\/$/, '');
}

function isBlankBaseURL(baseURL: string): boolean {
  return baseURL.trim() === '';
}

function getServiceBaseURL(serviceOptions?: Record<string, any>): unknown {
  const baseURL = serviceOptions?.baseURL;
  if (typeof baseURL === 'string' && isBlankBaseURL(baseURL)) {
    return null;
  }
  return baseURL;
}

function resolveServiceOptions(serviceOptions: Record<string, any> | undefined, app: any) {
  const rendered = app.environment.renderJsonTemplate(serviceOptions ?? {});
  if (rendered?.baseURL != null) {
    assertBaseURLString(rendered.baseURL);
    if (isBlankBaseURL(rendered.baseURL)) {
      delete rendered.baseURL;
      return rendered;
    }
    rendered.baseURL = normalizeBaseURL(rendered.baseURL);
  }
  return rendered;
}

export class EmbeddingProvider {
  protected opts: Record<string, any>;
  protected app: any;
  protected serviceOptions?: Record<string, any>;
  protected modelOptions?: Record<string, any>;

  constructor(opts: Record<string, any>) {
    this.opts = opts;
    const { app, serviceOptions, modelOptions } = opts;
    this.app = app;
    this.serviceOptions = resolveServiceOptions(serviceOptions, app);
    this.modelOptions = modelOptions;
  }

  createEmbedding(): EmbeddingsInterface {
    throw new Error('createEmbedding must be overridden');
  }

  protected getDefaultUrl(): string {
    return '';
  }

  protected get apiKey(): string {
    const { apiKey } = this.serviceOptions ?? {};
    if (!apiKey) {
      throw new Error('apiKey is required');
    }
    return apiKey;
  }

  protected get baseURL(): string {
    const baseURL = getServiceBaseURL(this.serviceOptions) ?? this.getDefaultUrl();
    if (!baseURL) {
      throw new Error('baseURL is required');
    }
    return normalizeBaseURL(baseURL);
  }

  protected get model(): string {
    const { model } = this.modelOptions ?? {};
    if (!model) {
      throw new Error('Embedding model is required');
    }
    return model;
  }
}
