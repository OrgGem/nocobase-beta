/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { EmbeddingsInterface } from '@langchain/core/embeddings';

// Local stubs for types not publicly exported from @nocobase/plugin-ai.
// These mirror the minimal runtime shape needed by CustomEmbeddingProvider.
// Keep in sync with the upstream definitions in that package.

export enum SupportedModel {
  LLM = 'LLM',
  EMBEDDING = 'EMBEDDING',
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
    this.serviceOptions = serviceOptions;
    this.modelOptions = modelOptions;
  }

  createEmbedding(): EmbeddingsInterface {
    throw new Error('createEmbedding must be overridden');
  }

  protected getDefaultUrl(): string {
    return '';
  }

  protected get apiKey(): any {
    return this.serviceOptions?.apiKey;
  }

  protected get baseURL(): any {
    return this.serviceOptions?.baseURL ?? this.getDefaultUrl();
  }

  protected get model(): any {
    return this.modelOptions?.model;
  }
}
