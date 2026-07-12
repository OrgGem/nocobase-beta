/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Client } from '@elastic/elasticsearch';
import { CollectionManager } from '@nocobase/data-source-manager';
import { ElasticsearchRepository } from './ElasticsearchRepository';

/**
 * Elasticsearch-specific CollectionManager.
 * Holds a reference to the ES client and registers the ES repository.
 */
export class ElasticsearchCollectionManager extends CollectionManager {
  public esClient: Client;

  constructor(options: { esClient: Client }) {
    super(options);

    this.esClient = options.esClient;

    // Register the Elasticsearch-specific repository
    this.registerRepositories({
      'elasticsearch-repo': ElasticsearchRepository,
    });
  }

  removeCollection(name: string) {
    this.collections.delete(name);
  }
}
