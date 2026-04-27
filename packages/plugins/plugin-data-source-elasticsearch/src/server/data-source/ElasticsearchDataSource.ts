/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DataSource } from '@nocobase/data-source-manager';
import { ElasticsearchCollectionManager } from './ElasticsearchCollectionManager';
import { Client, ClientOptions } from '@elastic/elasticsearch';

export type ElasticsearchDataSourceOptions = {
  name?: string;
  nodes?: string;
  username?: string;
  password?: string;
  apiKey?: string;
  rejectUnauthorized?: boolean;
  indexPattern?: string;
  addAllCollections?: boolean;
  [key: string]: any;
};

/**
 * Map an Elasticsearch field type to a NocoBase-compatible field type.
 */
function mapEsType(esType: string): { type: string; interface?: string; uiSchema?: any } {
  switch (esType) {
    case 'text':
    case 'keyword':
    case 'constant_keyword':
    case 'wildcard':
      return { type: 'string', interface: 'input', uiSchema: { type: 'string', 'x-component': 'Input' } };

    case 'long':
    case 'integer':
    case 'short':
    case 'byte':
      return { type: 'integer', interface: 'integer', uiSchema: { type: 'number', 'x-component': 'InputNumber' } };

    case 'double':
    case 'float':
    case 'half_float':
    case 'scaled_float':
      return { type: 'float', interface: 'number', uiSchema: { type: 'number', 'x-component': 'InputNumber' } };

    case 'boolean':
      return { type: 'boolean', interface: 'checkbox', uiSchema: { type: 'boolean', 'x-component': 'Checkbox' } };

    case 'date':
    case 'date_nanos':
      return { type: 'date', interface: 'datetime', uiSchema: { type: 'string', 'x-component': 'DatePicker' } };

    case 'object':
    case 'nested':
    case 'flattened':
      return { type: 'json', interface: 'json', uiSchema: { type: 'string', 'x-component': 'Input.TextArea' } };

    case 'ip':
    case 'geo_point':
    case 'geo_shape':
      return { type: 'string', interface: 'input', uiSchema: { type: 'string', 'x-component': 'Input' } };

    default:
      return { type: 'string', interface: 'input', uiSchema: { type: 'string', 'x-component': 'Input' } };
  }
}

/**
 * Normalise an API key to the base64-encoded "id:api_key" form that
 * @elastic/elasticsearch expects when auth.apiKey is a string.
 *
 * Accepted input forms:
 *   1. Already base64-encoded string (the "encoded" value from ES API key creation)
 *   2. "id:api_key" plain-text format  →  auto-encode to base64
 */
function normaliseApiKey(raw: string): string {
  const trimmed = raw.trim();

  // If the value contains a colon it is most likely the plain "id:api_key" form.
  // Base64-encoded strings never contain colons, so we can safely detect this case.
  if (trimmed.includes(':')) {
    return Buffer.from(trimmed).toString('base64');
  }

  // Assume it is already base64-encoded.
  return trimmed;
}

/**
 * Build @elastic/elasticsearch ClientOptions from plugin options.
 */
function buildClientOptions(options: ElasticsearchDataSourceOptions): ClientOptions {
  const nodes = (options.nodes || 'http://localhost:9200')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

  const clientOpts: ClientOptions = {
    nodes,
  };

  // Auth: API key takes priority over username/password
  if (options.apiKey) {
    clientOpts.auth = { apiKey: normaliseApiKey(options.apiKey) };
  } else if (options.username) {
    clientOpts.auth = {
      username: options.username,
      password: options.password || '',
    };
  }

  // TLS
  if (options.rejectUnauthorized === false) {
    clientOpts.tls = { rejectUnauthorized: false };
  }

  return clientOpts;
}

/**
 * Introspect a single ES index and return a collection definition.
 */
async function introspectIndex(
  client: Client,
  indexName: string,
): Promise<{ name: string; fields: any[]; [key: string]: any }> {
  const mappingResult = await client.indices.getMapping({ index: indexName });
  const mapping = mappingResult[indexName]?.mappings?.properties || {};

  // Build fields from mapping
  const fields: any[] = [
    {
      name: '_id',
      field: '_id',
      type: 'string',
      rawType: '_id',
      primaryKey: true,
      autoIncrement: false,
      allowNull: false,
      interface: 'input',
      uiSchema: {
        type: 'string',
        title: '_id',
        'x-component': 'Input',
        'x-read-pretty': true,
      },
    },
  ];

  for (const [fieldName, fieldMeta] of Object.entries(mapping)) {
    const meta = fieldMeta as any;
    const esType = meta.type || 'object';
    const mapped = mapEsType(esType);

    fields.push({
      name: fieldName,
      field: fieldName,
      rawType: esType,
      type: mapped.type,
      interface: mapped.interface,
      allowNull: true,
      uiSchema: {
        ...mapped.uiSchema,
        title: fieldName,
      },
    });
  }

  return {
    name: indexName,
    tableName: indexName,
    title: indexName,
    fields,
    filterTargetKey: '_id',
    repository: 'elasticsearch-repo',
    timestamps: false,
    introspected: true,
    simplePaginate: true,
  };
}

/**
 * Elasticsearch DataSource for NocoBase.
 * Each Elasticsearch index is mapped to a NocoBase collection.
 */
export class ElasticsearchDataSource extends DataSource {
  // DO NOT declare esClient as a class field!
  // TypeScript class fields compile to JS class field declarations that run AFTER super(),
  // which would overwrite the value set during createCollectionManager() with undefined.

  private get esClient(): Client {
    return (this.collectionManager as any)?.esClient;
  }

  /**
   * Extract connection options regardless of how they are passed:
   * - Lifecycle (init): { name, type, options: { nodes, username, ... } }
   * - Factory (load-tables): { name, nodes, username, ... } (flat)
   */
  private getConnectionOptions(options?: any): ElasticsearchDataSourceOptions {
    const opts = options || this.options || {};
    // If 'nodes' exists at top level, it's flat; otherwise check nested 'options'
    if (opts.nodes) {
      return opts;
    }
    if (opts.options && typeof opts.options === 'object') {
      return opts.options;
    }
    return opts;
  }

  createCollectionManager(options: any = {}) {
    const connectionOptions = this.getConnectionOptions(options);
    const clientOpts = buildClientOptions(connectionOptions);
    const esClient = new Client(clientOpts);

    return new ElasticsearchCollectionManager({
      esClient,
    });
  }

  /**
   * Load: connect to ES, introspect indices, create collections.
   * Called by DataSourceManager.add() with { localData } from persisted metadata.
   */
  async load(options: any = {}) {
    try {
      // Verify connection
      const pingResult = await this.esClient.ping();
      if (!pingResult) {
        throw new Error('Elasticsearch cluster is not responding');
      }
      this.logger?.info?.('[Elasticsearch] Connection established successfully');
    } catch (error) {
      this.logger?.error?.('[Elasticsearch] Failed to connect:', error);
      throw error;
    }

    // Introspect indices
    try {
      const connectionOptions = this.getConnectionOptions();
      const indexPattern = connectionOptions.indexPattern || '*';
      const catResult = await this.esClient.cat.indices({
        index: indexPattern,
        format: 'json',
        h: 'index,docs.count,status,health',
      });

      // Filter out system/internal indices (starting with .)
      const indices = (catResult as any[]).filter((idx: any) => idx.index && !idx.index.startsWith('.'));

      this.logger?.info?.(`[Elasticsearch] Found ${indices.length} indices`);

      let loaded = 0;
      const total = indices.length;

      for (const indexInfo of indices) {
        const indexName = indexInfo.index;

        try {
          const collectionOptions = await introspectIndex(this.esClient, indexName);

          this.collectionManager.defineCollection(collectionOptions as any);

          // Mark unsupported actions on the collection
          const collection = this.collectionManager.getCollection(indexName);
          if (collection) {
            (collection as any).unavailableActions = () => [
              'add',
              'remove',
              'set',
              'toggle',
              'firstOrCreate',
              'updateOrCreate',
            ];
          }

          loaded++;
          this.emitLoadingProgress({ total, loaded });
        } catch (error) {
          this.logger?.error?.(`[Elasticsearch] Failed to introspect index ${indexName}:`, error);
        }
      }

      this.logger?.info?.(`[Elasticsearch] Successfully loaded ${loaded}/${total} indices as collections`);
    } catch (error) {
      this.logger?.error?.('[Elasticsearch] Failed to introspect indices:', error);
      throw error;
    }
  }

  /**
   * Read all available indices from Elasticsearch.
   * Called by the data-source-manager's loadDataSourceTablesIntoCollections
   * middleware when `addAllCollections` is true.
   * Returns objects with { name } for the CollectionsTable UI component.
   */
  async readTables(): Promise<any> {
    try {
      const connectionOptions = this.getConnectionOptions();
      const indexPattern = connectionOptions.indexPattern || '*';
      const catResult = await this.esClient.cat.indices({
        index: indexPattern,
        format: 'json',
        h: 'index',
      });

      const indices = (catResult as any[])
        .filter((idx: any) => idx.index && !idx.index.startsWith('.'))
        .map((idx: any) => ({ name: idx.index }));

      return indices;
    } catch (error) {
      this.logger?.error?.('[Elasticsearch] readTables failed:', error);
      return [];
    }
  }

  /**
   * Load specific indices from Elasticsearch as collections.
   * Called by the data-source-manager's loadDataSourceTablesIntoCollections
   * middleware during data source creation/update.
   *
   * The middleware persists the selected collections to the
   * `dataSourcesCollections` table after this method returns.
   */
  async loadTables(ctx: any, tables: string[]): Promise<any> {
    if (!tables || tables.length === 0) {
      return;
    }

    this.logger?.info?.(`[Elasticsearch] Loading ${tables.length} specific indices:`, tables);

    for (const indexName of tables) {
      try {
        const collectionOptions = await introspectIndex(this.esClient, indexName);

        this.collectionManager.defineCollection(collectionOptions as any);

        // Mark unsupported actions on the collection
        const collection = this.collectionManager.getCollection(indexName);
        if (collection) {
          (collection as any).unavailableActions = () => [
            'add',
            'remove',
            'set',
            'toggle',
            'firstOrCreate',
            'updateOrCreate',
          ];
        }

        this.logger?.debug?.(`[Elasticsearch] Loaded index ${indexName} as collection`);
      } catch (error) {
        this.logger?.error?.(`[Elasticsearch] Failed to load index ${indexName}:`, error);
        throw error;
      }
    }
  }

  /**
   * Return public connection options (safe to expose to client — no password/apiKey).
   */
  publicOptions() {
    const opts = this.getConnectionOptions();
    return {
      nodes: opts.nodes,
      username: opts.username,
      indexPattern: opts.indexPattern,
      isExternal: true,
    };
  }

  /**
   * Close the Elasticsearch client.
   */
  async close() {
    if (this.esClient) {
      await this.esClient.close();
    }
  }

  /**
   * Test connection to an Elasticsearch cluster.
   */
  static async testConnection(options?: ElasticsearchDataSourceOptions): Promise<boolean> {
    if (!options) {
      throw new Error('Connection options are required');
    }

    const nodes = options.nodes?.trim();
    if (!nodes) {
      throw new Error('At least one Elasticsearch node URL is required');
    }

    const clientOpts = buildClientOptions(options);
    const client = new Client(clientOpts);

    try {
      const pingResult = await client.ping();
      if (!pingResult) {
        throw new Error('Elasticsearch cluster did not respond to ping');
      }

      // Also get cluster health for additional validation
      const health = await client.cluster.health();
      if (!health || !health.cluster_name) {
        throw new Error('Unable to retrieve cluster health');
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to Elasticsearch: ${message}`);
    } finally {
      await client.close();
    }
  }
}
