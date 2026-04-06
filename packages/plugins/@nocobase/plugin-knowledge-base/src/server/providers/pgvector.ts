/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { VectorDatabaseProvider, VectorDatabaseProviderInfo } from '@nocobase/plugin-ai/server';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';

export type PGVectorConnectParams = {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  tableName: string;
};

export class PGVectorDatabaseProvider implements VectorDatabaseProvider<PGVectorConnectParams, any> {
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
      columns: {
        idColumnName: 'id',
        vectorColumnName: 'embedding',
        contentColumnName: 'content',
        metadataColumnName: 'metadata',
      },
    };

    const vectorStore = await PGVectorStore.initialize(embeddings, config);
    return vectorStore;
  }
}

export const pgVectorProviderInfo: VectorDatabaseProviderInfo<PGVectorConnectParams, any> = {
  name: 'pgvector',
  spec: 'PGVector',
  provider: new PGVectorDatabaseProvider(),
};
