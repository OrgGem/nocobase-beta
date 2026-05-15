/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { EmbeddingsInterface } from '@langchain/core/embeddings';

export interface VectorDatabaseProvider<T = any, R = any> {
  validateConnectParams(connectParams: T): void;
  testConnection(connectParams: T): Promise<{ success: boolean; error?: string }>;
  createVectorStore(embeddings: EmbeddingsInterface, connectParams: T): Promise<R>;
}

export interface VectorDatabaseProviderFeature {
  register<T, R>(providerInfo: VectorDatabaseProviderInfo<T, R>): void;
  validateConnectParams<T>(providerName: string, connectParams: T): void;
  testConnection<T>(providerName: string, connectParams: T): Promise<{ success: boolean; error?: string }>;
  createVectorStore<T, R>(providerName: string, embeddings: EmbeddingsInterface, connectParams: T): Promise<R>;
  listProviders(): VectorDatabaseProviderInfo<unknown, unknown>[];
}

export interface VectorDatabaseProviderInfo<T = any, R = any> {
  name: string;
  spec?: string;
  provider: VectorDatabaseProvider<T, R>;
}

export class VectorDatabaseProviderImpl implements VectorDatabaseProviderFeature {
  private providers = new Map<string, VectorDatabaseProviderInfo<any, any>>();

  register<T, R>(providerInfo: VectorDatabaseProviderInfo<T, R>): void {
    this.providers.set(providerInfo.name, providerInfo);
  }

  validateConnectParams<T>(providerName: string, connectParams: T): void {
    const providerInfo = this.getProvider(providerName);
    providerInfo.provider.validateConnectParams(connectParams);
  }

  async testConnection<T>(providerName: string, connectParams: T): Promise<{ success: boolean; error?: string }> {
    const providerInfo = this.getProvider(providerName);
    return providerInfo.provider.testConnection(connectParams);
  }

  async createVectorStore<T, R>(providerName: string, embeddings: EmbeddingsInterface, connectParams: T): Promise<R> {
    const providerInfo = this.getProvider(providerName);
    return providerInfo.provider.createVectorStore(embeddings, connectParams) as Promise<R>;
  }

  listProviders(): VectorDatabaseProviderInfo<unknown, unknown>[] {
    return Array.from(this.providers.values());
  }

  private getProvider(name: string) {
    const providerInfo = this.providers.get(name);
    if (!providerInfo) {
      throw new Error(`Vector database provider "${name}" is not registered`);
    }
    return providerInfo;
  }
}
