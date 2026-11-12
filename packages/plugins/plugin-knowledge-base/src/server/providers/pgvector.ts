// SPDX-License-Identifier: Apache-2.0

import type { VectorDatabaseProvider, VectorDatabaseProviderInfo } from '../features/vector-database-provider-impl';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { createHash } from 'crypto';

export type PGVectorConnectParams = {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  tableName: string;
};

export class PGVectorDatabaseProvider implements VectorDatabaseProvider<PGVectorConnectParams, any> {
  private vectorStoreCache = new Map<
    string,
    { store: { end(): Promise<void> }; fingerprint: string; location: string }
  >();
  private cacheQueue: Promise<void> = Promise.resolve();
  private readonly maxCachedStores = 16;

  private digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.cacheQueue;
    let release: () => void = () => {};
    this.cacheQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    await this.serialize(async () => {
      const stores = Array.from(this.vectorStoreCache.values(), (entry) => entry.store);
      this.vectorStoreCache.clear();
      await Promise.allSettled(stores.map((store) => store.end()));
    });
  }

  validateConnectParams(connectParams: PGVectorConnectParams): void {
    const { host, port, username, password, database, tableName } = connectParams || {};

    if (!host) {
      throw new Error('Host is required');
    }
    if (!port) {
      throw new Error('Port is required');
    }
    if (!username) {
      throw new Error('Username is required');
    }
    if (!password) {
      throw new Error('Password is required');
    }
    if (!database) {
      throw new Error('Database is required');
    }
    if (!tableName) {
      throw new Error('Table name is required');
    }
  }

  async testConnection(connectParams: PGVectorConnectParams): Promise<{ success: boolean; error?: string }> {
    this.validateConnectParams(connectParams);

    let client: any;
    try {
      const { Client } = await import('pg');
      client = new Client({
        host: connectParams.host,
        port: connectParams.port,
        user: connectParams.username,
        password: connectParams.password,
        database: connectParams.database,
        connectionTimeoutMillis: 10_000,
      });

      await client.connect();

      // Check if pgvector extension is installed
      const result = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");

      if (result.rows.length === 0) {
        return {
          success: false,
          error: 'pgvector extension is not installed. Run: CREATE EXTENSION vector;',
        };
      }

      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message ?? 'Failed to connect to PostgreSQL',
      };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  async createVectorStore(embeddings: EmbeddingsInterface, connectParams: PGVectorConnectParams): Promise<any> {
    this.validateConnectParams(connectParams);
    return this.serialize(async () => {
      const location = this.digest([
        connectParams.host,
        connectParams.port,
        connectParams.database,
        connectParams.tableName,
      ]);
      const fingerprint = this.digest([
        connectParams.host,
        connectParams.port,
        connectParams.username,
        connectParams.password,
        connectParams.database,
        connectParams.tableName,
      ]);
      const model = embeddings as EmbeddingsInterface & { modelName?: string; model?: string };
      const embedId = model.modelName || model.model || embeddings.constructor.name;
      const cacheKey = this.digest([location, embedId]);
      const cached = this.vectorStoreCache.get(cacheKey);
      if (cached?.fingerprint === fingerprint) {
        this.vectorStoreCache.delete(cacheKey);
        this.vectorStoreCache.set(cacheKey, cached);
        return cached.store;
      }

      const { PGVectorStore } = await import('@langchain/community/vectorstores/pgvector');
      const config = {
        postgresConnectionOptions: {
          host: connectParams.host,
          port: connectParams.port,
          user: connectParams.username,
          password: connectParams.password,
          database: connectParams.database,
        },
        tableName: connectParams.tableName,
        // LangChain otherwise returns cosine distance (zero is best).
        distanceStrategy: 'cosine' as const,
        scoreNormalization: 'similarity' as const,
        columns: {
          idColumnName: 'id',
          vectorColumnName: 'embedding',
          contentColumnName: 'content',
          metadataColumnName: 'metadata',
        },
      };
      const vectorStore = await PGVectorStore.initialize(embeddings, config);
      const displaced: Array<{ end(): Promise<void> }> = [];
      for (const [key, entry] of this.vectorStoreCache) {
        if ((entry.location === location && entry.fingerprint !== fingerprint) || key === cacheKey) {
          this.vectorStoreCache.delete(key);
          displaced.push(entry.store);
        }
      }
      this.vectorStoreCache.set(cacheKey, { store: vectorStore, fingerprint, location });
      while (this.vectorStoreCache.size > this.maxCachedStores) {
        const oldest = this.vectorStoreCache.entries().next().value;
        if (!oldest) break;
        this.vectorStoreCache.delete(oldest[0]);
        displaced.push(oldest[1].store);
      }
      await Promise.allSettled(displaced.map((store) => store.end()));
      return vectorStore;
    });
  }
}

export const pgVectorProviderInfo: VectorDatabaseProviderInfo<PGVectorConnectParams, any> = {
  name: 'pgvector',
  spec: 'PGVector',
  provider: new PGVectorDatabaseProvider(),
};
