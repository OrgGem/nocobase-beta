/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Client } from '@elastic/elasticsearch';
import { ICollection, IModel, IRepository } from '@nocobase/data-source-manager';

type FilterValue = string | number | boolean | null | Array<string | number | boolean>;
type FilterRecord = Record<string, FilterValue | Record<string, FilterValue> | FilterRecord[]>;
type SortValue = string | string[];

type ElasticsearchHit = {
  _id?: string;
  _index?: string;
  _source?: Record<string, unknown>;
  found?: boolean;
};

type ElasticsearchError = Error & {
  meta?: {
    statusCode?: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isElasticsearchError(error: unknown): error is ElasticsearchError {
  return error instanceof Error && isRecord(error) && isRecord(error.meta);
}

function emptyModel(): IModel {
  return {
    toJSON: () => ({}),
  };
}

export class ElasticsearchRepository implements IRepository {
  public collection: ICollection;
  private client: Client;
  private indexName: string;

  constructor(collection: ICollection) {
    this.collection = collection;
    this.indexName = collection.options?.tableName || collection.name;
    this.client = collection.collectionManager.esClient;
  }

  private hitToModel(hit: ElasticsearchHit): IModel {
    const data = {
      _id: hit._id,
      _index: hit._index,
      ...(hit._source || {}),
    };

    return {
      ...data,
      toJSON() {
        return data;
      },
    };
  }

  private buildQuery(filter?: FilterRecord): Record<string, unknown> {
    if (!filter || Object.keys(filter).length === 0) {
      return { match_all: {} };
    }

    const must: Array<Record<string, unknown>> = [];

    for (const [key, value] of Object.entries(filter)) {
      if (['context', 'appends', 'except', 'tree'].includes(key)) {
        continue;
      }

      if (key === '$and' && Array.isArray(value)) {
        const subQueries = value.map((sub) => this.buildQuery(sub as FilterRecord));
        must.push({ bool: { must: subQueries } });
        continue;
      }

      if (key === '$or' && Array.isArray(value)) {
        const subQueries = value.map((sub) => this.buildQuery(sub as FilterRecord));
        must.push({ bool: { should: subQueries, minimum_should_match: 1 } });
        continue;
      }

      if (isRecord(value) && !Array.isArray(value)) {
        for (const [op, opVal] of Object.entries(value)) {
          switch (op) {
            case '$eq':
              must.push({ match_phrase: { [key]: opVal } });
              break;
            case '$ne':
              must.push({ bool: { must_not: [{ match_phrase: { [key]: opVal } }] } });
              break;
            case '$gt':
              must.push({ range: { [key]: { gt: opVal } } });
              break;
            case '$gte':
              must.push({ range: { [key]: { gte: opVal } } });
              break;
            case '$lt':
              must.push({ range: { [key]: { lt: opVal } } });
              break;
            case '$lte':
              must.push({ range: { [key]: { lte: opVal } } });
              break;
            case '$like':
            case '$includes':
              must.push({ wildcard: { [`${key}.keyword`]: `*${opVal}*` } });
              break;
            case '$in':
              must.push({ terms: { [key]: opVal } });
              break;
            case '$notIn':
              must.push({ bool: { must_not: [{ terms: { [key]: opVal } }] } });
              break;
            default:
              must.push({ match_phrase: { [key]: opVal } });
          }
        }
      } else {
        must.push({ match_phrase: { [key]: value } });
      }
    }

    if (must.length === 0) {
      return { match_all: {} };
    }

    if (must.length === 1) {
      return must[0];
    }

    return { bool: { must } };
  }

  private buildSort(sort?: SortValue): Array<Record<string, { order: 'asc' | 'desc' }>> | undefined {
    if (!sort) {
      return undefined;
    }

    const sortArray = Array.isArray(sort) ? sort : [sort];
    return sortArray.map((item) => {
      if (item.startsWith('-')) {
        return { [item.slice(1)]: { order: 'desc' } };
      }

      return { [item]: { order: 'asc' } };
    });
  }

  async find(options: Record<string, unknown> = {}): Promise<IModel[]> {
    const { filter, sort, limit, offset, page, pageSize, fields } = options;
    const size = Number(limit || pageSize || 20);
    const from = Number(offset ?? (page ? (Number(page) - 1) * size : 0));

    const body: Record<string, unknown> = {
      query: this.buildQuery(filter as FilterRecord | undefined),
      from,
      size,
    };

    const esSort = this.buildSort(sort as SortValue | undefined);
    if (esSort) {
      body.sort = esSort;
    }

    if (Array.isArray(fields) && fields.length > 0) {
      body._source = fields;
    }

    try {
      const result = await this.client.search({ index: this.indexName, body });
      const hits = Array.isArray(result.hits?.hits) ? result.hits.hits : [];
      return hits.map((hit) => this.hitToModel(hit as ElasticsearchHit));
    } catch (error) {
      console.error(`[Elasticsearch] Search error on index ${this.indexName}:`, getErrorMessage(error));
      return [];
    }
  }

  async findOne(options: Record<string, unknown> = {}): Promise<IModel> {
    const { filterByTk, filter } = options;

    if (filterByTk) {
      try {
        const result = (await this.client.get({
          index: this.indexName,
          id: String(filterByTk),
        })) as ElasticsearchHit;

        if (result.found === false) {
          return emptyModel();
        }

        return this.hitToModel(result);
      } catch (error) {
        if (isElasticsearchError(error) && error.meta?.statusCode === 404) {
          return emptyModel();
        }

        console.error(`[Elasticsearch] Get error on index ${this.indexName}:`, getErrorMessage(error));
        return emptyModel();
      }
    }

    const results = await this.find({ filter, limit: 1 });
    return results[0] || emptyModel();
  }

  async count(options: Record<string, unknown> = {}): Promise<number> {
    const { filter } = options;

    try {
      const result = await this.client.count({
        index: this.indexName,
        body: {
          query: this.buildQuery(filter as FilterRecord | undefined),
        },
      });
      return result.count || 0;
    } catch (error) {
      console.error(`[Elasticsearch] Count error on index ${this.indexName}:`, getErrorMessage(error));
      return 0;
    }
  }

  async findAndCount(options: Record<string, unknown> = {}): Promise<[IModel[], number]> {
    const { filter, sort, limit, offset, page, pageSize, fields } = options;
    const size = Number(limit || pageSize || 20);
    const from = Number(offset ?? (page ? (Number(page) - 1) * size : 0));

    const body: Record<string, unknown> = {
      query: this.buildQuery(filter as FilterRecord | undefined),
      from,
      size,
      track_total_hits: true,
    };

    const esSort = this.buildSort(sort as SortValue | undefined);
    if (esSort) {
      body.sort = esSort;
    }

    if (Array.isArray(fields) && fields.length > 0) {
      body._source = fields;
    }

    try {
      const result = await this.client.search({ index: this.indexName, body });
      const hits = Array.isArray(result.hits?.hits) ? result.hits.hits : [];
      const total = typeof result.hits?.total === 'number' ? result.hits.total : result.hits?.total?.value || 0;
      return [hits.map((hit) => this.hitToModel(hit as ElasticsearchHit)), total];
    } catch (error) {
      console.error(`[Elasticsearch] Search error on index ${this.indexName}:`, getErrorMessage(error));
      return [[], 0];
    }
  }

  async create(options: { values?: Record<string, unknown> }): Promise<IModel> {
    const values = options.values || {};

    try {
      const result = await this.client.index({
        index: this.indexName,
        body: values,
        refresh: 'wait_for',
      });

      return this.hitToModel({
        _id: result._id,
        _index: result._index,
        _source: values,
      });
    } catch (error) {
      console.error(`[Elasticsearch] Index error on ${this.indexName}:`, getErrorMessage(error));
      throw error;
    }
  }

  async update(options: { filterByTk?: string | number; values?: Record<string, unknown> }): Promise<IModel> {
    const { filterByTk, values = {} } = options;
    if (!filterByTk) {
      throw new Error('filterByTk (_id) is required for update');
    }

    try {
      await this.client.update({
        index: this.indexName,
        id: String(filterByTk),
        body: { doc: values },
        refresh: 'wait_for',
      });

      const data = { _id: filterByTk, ...values };
      return {
        ...data,
        toJSON: () => data,
      };
    } catch (error) {
      console.error(`[Elasticsearch] Update error on ${this.indexName}:`, getErrorMessage(error));
      throw error;
    }
  }

  async destroy(options: { filterByTk?: string | number }): Promise<IModel> {
    const { filterByTk } = options;
    if (!filterByTk) {
      throw new Error('filterByTk (_id) is required for destroy');
    }

    try {
      await this.client.delete({
        index: this.indexName,
        id: String(filterByTk),
        refresh: 'wait_for',
      });

      const data = { _id: filterByTk };
      return {
        ...data,
        toJSON: () => data,
      };
    } catch (error) {
      console.error(`[Elasticsearch] Delete error on ${this.indexName}:`, getErrorMessage(error));
      throw error;
    }
  }
}
