/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Client } from '@elastic/elasticsearch';
import type { ClientOptions } from '@elastic/elasticsearch';
import { DataSource } from '@nocobase/data-source-manager';
import type { CollectionOptions, FieldOptions, PartialCollectionOptions } from '@nocobase/data-source-manager';
import { ElasticsearchCollectionManager } from './ElasticsearchCollectionManager';

export type ElasticsearchDataSourceOptions = {
  name?: string;
  nodes?: string;
  username?: string;
  password?: string;
  apiKey?: string;
  rejectUnauthorized?: boolean;
  indexPattern?: string;
  addAllCollections?: boolean;
  selectedCollections?: string[];
  options?: ElasticsearchDataSourceOptions;
  [key: string]: unknown;
};

type ElasticsearchIndexInfo = {
  name: string;
};

type ElasticsearchFieldMapping = {
  type?: string;
  [key: string]: unknown;
};

type ElasticsearchLocalData = Record<string, PartialCollectionOptions | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeElasticsearchCollectionNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const names = value
    .map((item) => {
      if (typeof item === 'string') {
        return item.trim();
      }

      if (!isRecord(item)) {
        return '';
      }

      if (item.selected === false) {
        return '';
      }

      return toOptionalString(item.name) || toOptionalString(item.value) || '';
    })
    .filter(Boolean);

  return [...new Set(names)];
}

export function getElasticsearchConnectionOptions(options?: unknown): ElasticsearchDataSourceOptions {
  if (!isRecord(options)) {
    return {};
  }

  if (typeof options.nodes === 'string') {
    return options as ElasticsearchDataSourceOptions;
  }

  if (isRecord(options.options)) {
    return options.options as ElasticsearchDataSourceOptions;
  }

  return options as ElasticsearchDataSourceOptions;
}

function mapEsType(esType: string): Pick<FieldOptions, 'type' | 'interface' | 'uiSchema'> {
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

function normaliseApiKey(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.includes(':')) {
    return Buffer.from(trimmed).toString('base64');
  }

  return trimmed;
}

function buildClientOptions(options: ElasticsearchDataSourceOptions): ClientOptions {
  const nodes = (options.nodes || 'http://localhost:9200')
    .split(',')
    .map((node) => node.trim())
    .filter(Boolean);

  const clientOpts: ClientOptions = {
    nodes,
  };

  if (options.apiKey) {
    clientOpts.auth = { apiKey: normaliseApiKey(options.apiKey) };
  } else if (options.username) {
    clientOpts.auth = {
      username: options.username,
      password: options.password || '',
    };
  }

  if (options.rejectUnauthorized === false) {
    clientOpts.tls = { rejectUnauthorized: false };
  }

  return clientOpts;
}

async function readIndexNames(client: Client, options: ElasticsearchDataSourceOptions): Promise<string[]> {
  const indexPattern = options.indexPattern || '*';
  const catResult = await client.cat.indices({
    index: indexPattern,
    format: 'json',
    h: 'index',
  });

  if (!Array.isArray(catResult)) {
    return [];
  }

  return catResult
    .map((item) => (isRecord(item) ? toOptionalString(item.index) : undefined))
    .filter((indexName): indexName is string => !!indexName && !indexName.startsWith('.'));
}

async function introspectIndex(client: Client, indexName: string): Promise<CollectionOptions> {
  const mappingResult = await client.indices.getMapping({ index: indexName });
  const mappingRoot = isRecord(mappingResult) ? mappingResult[indexName] : undefined;
  const mappings = isRecord(mappingRoot) ? mappingRoot.mappings : undefined;
  const properties = isRecord(mappings) && isRecord(mappings.properties) ? mappings.properties : {};

  const fields: FieldOptions[] = [
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

  for (const [fieldName, fieldMeta] of Object.entries(properties)) {
    const meta: ElasticsearchFieldMapping = isRecord(fieldMeta) ? fieldMeta : {};
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

function mergeFieldOptions(introspected: FieldOptions, local?: Partial<FieldOptions>): FieldOptions {
  if (!local) {
    return introspected;
  }

  return {
    ...introspected,
    ...local,
    name: introspected.name,
    field: local.field || introspected.field,
    rawType: introspected.rawType,
    type: local.type || introspected.type,
    interface: local.interface || introspected.interface,
    uiSchema: {
      ...(introspected.uiSchema || {}),
      ...(local.uiSchema || {}),
    },
  };
}

function mergeCollectionOptions(
  introspected: CollectionOptions,
  localOptions?: PartialCollectionOptions,
): CollectionOptions {
  if (!localOptions) {
    return introspected;
  }

  const localFields = Array.isArray(localOptions.fields) ? localOptions.fields : [];
  const localFieldsByName = new Map(localFields.map((field) => [field.name, field]));
  const introspectedFieldNames = new Set(introspected.fields.map((field) => field.name));
  const mergedFields = introspected.fields.map((field) => mergeFieldOptions(field, localFieldsByName.get(field.name)));
  const extraFields = localFields.filter(
    (field): field is FieldOptions => !!field.name && !introspectedFieldNames.has(field.name),
  );

  return {
    ...introspected,
    ...localOptions,
    name: introspected.name,
    tableName: introspected.tableName,
    fields: [...mergedFields, ...extraFields],
    filterTargetKey: '_id',
    repository: 'elasticsearch-repo',
    timestamps: false,
    introspected: true,
    simplePaginate: true,
  };
}

export class ElasticsearchDataSource extends DataSource {
  private get esClient(): Client {
    return (this.collectionManager as ElasticsearchCollectionManager | undefined)?.esClient;
  }

  private getConnectionOptions(options?: unknown): ElasticsearchDataSourceOptions {
    return getElasticsearchConnectionOptions(options || this.options);
  }

  createCollectionManager(options: unknown = {}) {
    const connectionOptions = this.getConnectionOptions(options);
    const clientOpts = buildClientOptions(connectionOptions);
    const esClient = new Client(clientOpts);

    return new ElasticsearchCollectionManager({
      esClient,
    });
  }

  async load(options: { localData?: ElasticsearchLocalData } = {}) {
    try {
      const pingResult = await this.esClient.ping();
      if (!pingResult) {
        throw new Error('Elasticsearch cluster is not responding');
      }
      this.logger?.info?.('[Elasticsearch] Connection established successfully');
    } catch (error) {
      this.logger?.error?.('[Elasticsearch] Failed to connect:', error);
      throw error;
    }

    try {
      const indexNames = await this.getIndexNamesForLoad();

      this.logger?.info?.(`[Elasticsearch] Loading ${indexNames.length} indices`);

      let loaded = 0;
      const total = indexNames.length;

      for (const indexName of indexNames) {
        try {
          const collectionOptions = mergeCollectionOptions(
            await introspectIndex(this.esClient, indexName),
            options.localData?.[indexName],
          );

          this.collectionManager.defineCollection(collectionOptions);
          this.markUnsupportedActions(indexName);

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

  private async getIndexNamesForLoad(): Promise<string[]> {
    const connectionOptions = this.getConnectionOptions();

    if (connectionOptions.addAllCollections === false) {
      const selectedCollections = normalizeElasticsearchCollectionNames(connectionOptions.selectedCollections);
      return selectedCollections.filter((name) => !name.startsWith('.'));
    }

    return readIndexNames(this.esClient, connectionOptions);
  }

  private markUnsupportedActions(collectionName: string) {
    const collection = this.collectionManager.getCollection(collectionName);
    if (!collection) {
      return;
    }

    collection.unavailableActions = () => ['add', 'remove', 'set', 'toggle', 'firstOrCreate', 'updateOrCreate'];
  }

  async readTables(): Promise<ElasticsearchIndexInfo[]> {
    try {
      return ElasticsearchDataSource.readIndices(this.getConnectionOptions(), this.esClient);
    } catch (error) {
      this.logger?.error?.('[Elasticsearch] readTables failed:', error);
      return [];
    }
  }

  async loadTables(ctx: unknown, tables: string[]): Promise<void> {
    if (!tables?.length) {
      return;
    }

    this.logger?.info?.(`[Elasticsearch] Loading ${tables.length} specific indices:`, tables);

    for (const indexName of tables) {
      try {
        const collectionOptions = await introspectIndex(this.esClient, indexName);

        this.collectionManager.defineCollection(collectionOptions);
        this.markUnsupportedActions(indexName);

        this.logger?.debug?.(`[Elasticsearch] Loaded index ${indexName} as collection`);
      } catch (error) {
        this.logger?.error?.(`[Elasticsearch] Failed to load index ${indexName}:`, error);
        throw error;
      }
    }
  }

  publicOptions() {
    const opts = this.getConnectionOptions();
    return {
      nodes: opts.nodes,
      username: opts.username,
      indexPattern: opts.indexPattern,
      rejectUnauthorized: opts.rejectUnauthorized,
      addAllCollections: opts.addAllCollections,
      selectedCollections: opts.selectedCollections,
      isExternal: true,
    };
  }

  async close() {
    if (this.esClient) {
      await this.esClient.close();
    }
  }

  static async readIndices(
    options?: ElasticsearchDataSourceOptions,
    existingClient?: Client,
  ): Promise<ElasticsearchIndexInfo[]> {
    const connectionOptions = getElasticsearchConnectionOptions(options);
    const client = existingClient || new Client(buildClientOptions(connectionOptions));

    try {
      const indexNames = await readIndexNames(client, connectionOptions);
      return indexNames.map((name) => ({ name }));
    } finally {
      if (!existingClient) {
        await client.close();
      }
    }
  }

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

      const health = await client.cluster.health();
      if (!health || !health.cluster_name) {
        throw new Error('Unable to retrieve cluster health');
      }

      return true;
    } catch (error) {
      throw new Error(`Failed to connect to Elasticsearch: ${getErrorMessage(error)}`);
    } finally {
      await client.close();
    }
  }
}
