/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
