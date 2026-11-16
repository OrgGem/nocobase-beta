// SPDX-License-Identifier: Apache-2.0

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
