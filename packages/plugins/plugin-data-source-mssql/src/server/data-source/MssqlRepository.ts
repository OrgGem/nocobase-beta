/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Repository, Collection, FindOptions, Model } from '@nocobase/database';
import { MssqlSmartCursorBuilder } from './MssqlSmartCursorBuilder';

/**
 * MSSQL-specific Repository with optimized cursor-based pagination support
 */
export class MssqlRepository<
  TModelAttributes extends {} = any,
  TCreationAttributes extends {} = TModelAttributes,
> extends Repository<TModelAttributes, TCreationAttributes> {
  private mssqlCursorBuilder: MssqlSmartCursorBuilder;

  constructor(collection: Collection) {
    super(collection);

    // Initialize MSSQL-specific cursor builder
    this.mssqlCursorBuilder = new MssqlSmartCursorBuilder(
      this.database.sequelize,
      this.model.tableName,
      this.collection,
    );
  }

  /**
   * Cursor-based pagination query function optimized for MSSQL.
   * Ideal for large datasets (e.g., millions of rows)
   *
   * Note:
   *  1. Does not support jumping to arbitrary pages (e.g., "Page 5")
   *  2. Requires a stable, indexed sort field (e.g. ID, createdAt)
   *  3. If custom orderBy is used, it must match the cursor field(s) and direction
   *
   * @param options - Query options
   */
  async chunkWithCursor(
    options: FindOptions & {
      chunkSize: number;
      callback: (rows: Model[], options: FindOptions) => Promise<void>;
      beforeFind?: (options: FindOptions) => Promise<void>;
      afterFind?: (rows: Model[], options: FindOptions) => Promise<void>;
    },
  ) {
    return await this.mssqlCursorBuilder.chunk({
      ...options,
      find: this.find.bind(this),
    });
  }
}
