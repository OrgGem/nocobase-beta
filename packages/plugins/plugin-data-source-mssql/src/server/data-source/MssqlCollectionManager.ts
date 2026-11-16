// SPDX-License-Identifier: Apache-2.0

import { SequelizeCollectionManager } from '@nocobase/data-source-manager';
import { MssqlRepository } from './MssqlRepository';

export class MssqlCollectionManager extends SequelizeCollectionManager {
  constructor(options: any) {
    super(options);

    // Register MSSQL-specific repository with cursor-based pagination support
    this.db.registerRepositories({
      'mssql-repo': MssqlRepository,
    });
  }

  removeCollection(name: string) {
    this.db.removeCollection(name);
  }
}
