/**
 * MSSQL V2 Collection Manager
 *
 * Holds a reference to the driver and registers the MSSQL repository.
 * Follows the same pattern as ElasticsearchCollectionManager.
 */

import { CollectionManager } from '@nocobase/data-source-manager';
import { MssqlRepository } from './MssqlRepository';
import type { EngineDriver } from '../types';

export class MssqlCollectionManager extends CollectionManager {
  public driver: EngineDriver;

  constructor(options: { dataSource: any; driver: EngineDriver }) {
    super(options);
    this.driver = options.driver;

    // Register the MSSQL-specific repository
    this.registerRepositories({
      'mssql-v2-repo': MssqlRepository,
    });
  }

  /**
   * Remove a collection from memory.
   */
  removeCollection(name: string): void {
    this.collections.delete(name);
  }
}
