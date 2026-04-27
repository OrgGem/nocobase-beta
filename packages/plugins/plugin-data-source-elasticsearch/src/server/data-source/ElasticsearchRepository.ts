/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ICollection, IModel, IRepository } from '@nocobase/data-source-manager';

/**
 * Elasticsearch-specific Repository.
 * Implements CRUD operations via the Elasticsearch REST API.
 */
export class ElasticsearchRepository implements IRepository {
  public collection: ICollection;
  private client: any; // ES Client
  private indexName: string;

  constructor(collection: ICollection) {
    this.collection = collection;
    this.indexName = collection.options?.tableName || collection.name;
    // The ES client is stored on the collectionManager
    this.client = (collection.collectionManager as any).esClient;
  }

  /**
   * Convert an ES hit to an IModel-compatible object.
   */
  private hitToModel(hit: any): IModel {
    const data = {
      _id: hit._id,
      _index: hit._index,
      ...hit._source,
    };
    return {
      ...data,
      toJSON() {
        return data;
      },
    };
  }

  /**
   * Build an Elasticsearch query body from NocoBase filter options.
   * Supports basic field equality and nested $and/$or.
   */
  private buildQuery(filter: any): any {
    if (!filter || Object.keys(filter).length === 0) {
      return { match_all: {} };
    }

    const must: any[] = [];

    for (const [key, value] of Object.entries(filter)) {
      // Skip non-filter keys injected by the framework
      if (key === 'context' || key === 'appends' || key === 'except' || key === 'tree') {
        continue;
      }

      if (key === '$and' && Array.isArray(value)) {
        const subQueries = value.map((sub) => this.buildQuery(sub));
        must.push({ bool: { must: subQueries } });
      } else if (key === '$or' && Array.isArray(value)) {
        const subQueries = value.map((sub) => this.buildQuery(sub));
        must.push({ bool: { should: subQueries, minimum_should_match: 1 } });
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Handle operators like { field: { $eq: val } }
        for (const [op, opVal] of Object.entries(value)) {
          switch (op) {
            case '$eq':
              // Use match instead of term — term fails on analyzed text fields
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
              must.push({ wildcard: { [key + '.keyword']: `*${opVal}*` } });
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
        // Simple equality — use match_phrase for safety with text fields
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

  /**
   * Build Elasticsearch sort from NocoBase sort options.
   * Accepts: string[], e.g. ['-createdAt', 'title']
   */
  private buildSort(sort?: string | string[]): any[] | undefined {
    if (!sort) return undefined;
    const sortArray = Array.isArray(sort) ? sort : [sort];
    return sortArray.map((s) => {
      if (s.startsWith('-')) {
        return { [s.slice(1)]: { order: 'desc' } };
      }
      return { [s]: { order: 'asc' } };
    });
  }

  async find(options: any = {}): Promise<IModel[]> {
    const { filter, sort, limit, offset, page, pageSize, fields } = options;

    const size = limit || pageSize || 20;
    const from = offset ?? (page ? (page - 1) * size : 0);

    const searchParams: any = {
      index: this.indexName,
      body: {
        query: this.buildQuery(filter),
        from,
        size,
      },
    };

    const esSort = this.buildSort(sort);
    if (esSort) {
      searchParams.body.sort = esSort;
    }

    if (fields && fields.length > 0) {
      searchParams.body._source = fields;
    }

    try {
      const result = await this.client.search(searchParams);
      const hits = result.hits?.hits || [];
      return hits.map((hit: any) => this.hitToModel(hit));
    } catch (error) {
      console.error(`[Elasticsearch] Search error on index ${this.indexName}:`, error.message);
      return [];
    }
  }

  async findOne(options: any = {}): Promise<IModel> {
    const { filterByTk, filter } = options;

    if (filterByTk) {
      try {
        const result = await this.client.get({
          index: this.indexName,
          id: filterByTk,
        });
        // ES get API returns { _id, _index, _source, found } directly
        if (result.found === false) {
          return { toJSON: () => ({}) };
        }
        return this.hitToModel(result);
      } catch (error) {
        if (error?.meta?.statusCode === 404) {
          return { toJSON: () => ({}) };
        }
        console.error(`[Elasticsearch] Get error on index ${this.indexName}:`, error.message);
        return { toJSON: () => ({}) };
      }
    }

    const results = await this.find({ filter, limit: 1 });
    return results[0] || { toJSON: () => ({}) };
  }

  async count(options: any = {}): Promise<number> {
    const { filter } = options;
    try {
      const result = await this.client.count({
        index: this.indexName,
        body: {
          query: this.buildQuery(filter),
        },
      });
      return result.count || 0;
    } catch (error) {
      console.error(`[Elasticsearch] Count error on index ${this.indexName}:`, error.message);
      return 0;
    }
  }

  async findAndCount(options: any = {}): Promise<[IModel[], number]> {
    const { filter, sort, limit, offset, page, pageSize, fields } = options;

    const size = limit || pageSize || 20;
    const from = offset ?? (page ? (page - 1) * size : 0);

    const searchParams: any = {
      index: this.indexName,
      body: {
        query: this.buildQuery(filter),
        from,
        size,
        track_total_hits: true,
      },
    };

    const esSort = this.buildSort(sort);
    if (esSort) {
      searchParams.body.sort = esSort;
    }

    if (fields && fields.length > 0) {
      searchParams.body._source = fields;
    }

    try {
      const result = await this.client.search(searchParams);
      const hits = result.hits?.hits || [];
      const total = typeof result.hits?.total === 'number' ? result.hits.total : result.hits?.total?.value || 0;
      return [hits.map((hit: any) => this.hitToModel(hit)), total];
    } catch (error) {
      console.error(`[Elasticsearch] Search error on index ${this.indexName}:`, error.message);
      return [[], 0];
    }
  }

  async create(options: any): Promise<any> {
    const { values } = options;
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
      console.error(`[Elasticsearch] Index error on ${this.indexName}:`, error.message);
      throw error;
    }
  }

  async update(options: any): Promise<any> {
    const { filterByTk, values } = options;
    if (!filterByTk) {
      throw new Error('filterByTk (_id) is required for update');
    }
    try {
      await this.client.update({
        index: this.indexName,
        id: filterByTk,
        body: { doc: values },
        refresh: 'wait_for',
      });
      return { _id: filterByTk, ...values };
    } catch (error) {
      console.error(`[Elasticsearch] Update error on ${this.indexName}:`, error.message);
      throw error;
    }
  }

  async destroy(options: any): Promise<any> {
    const { filterByTk } = options;
    if (!filterByTk) {
      throw new Error('filterByTk (_id) is required for destroy');
    }
    try {
      await this.client.delete({
        index: this.indexName,
        id: filterByTk,
        refresh: 'wait_for',
      });
      return { _id: filterByTk };
    } catch (error) {
      console.error(`[Elasticsearch] Delete error on ${this.indexName}:`, error.message);
      throw error;
    }
  }
}
