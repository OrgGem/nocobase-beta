/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Collection, CollectionContext, CollectionOptions } from '@nocobase/database';
import { ModelStatic, QueryInterfaceDropTableOptions } from 'sequelize';
import type { Model } from '@nocobase/database';
import { normalizeSqlCollectionQuery } from '../utils/sql-validator';
import { SQLModel } from './sql-model';

export class PostgresSQLCollection extends Collection {
  constructor(options: CollectionOptions, context: CollectionContext) {
    options.autoGenId = false;
    options.timestamps = false;
    options.underscored = false;
    super(options, context);
  }

  get filterTargetKey() {
    const targetKey = this.options.filterTargetKey || 'id';
    if (Array.isArray(targetKey)) return targetKey;
    if (targetKey && this.model.getAttributes()[targetKey]) return targetKey;
    return this.model.primaryKeyAttributes.length > 1 ? null : this.model.primaryKeyAttribute;
  }

  isSql() {
    return true;
  }

  unavailableActions(): string[] {
    return ['create', 'update', 'destroy', 'importXlsx', 'destroyMany', 'updateMany'];
  }

  collectionSchema() {
    return undefined;
  }

  modelInit() {
    const normalizedSql = normalizeSqlCollectionQuery(String(this.options.sql || ''));
    if (this.model) {
      (this.model as unknown as typeof SQLModel).sql = normalizedSql;
      return;
    }
    const model = class extends SQLModel {};
    const registeredModel = model as unknown as ModelStatic<Model>;
    registeredModel.init(null, { ...this.sequelizeModelOptions(), schema: undefined });
    registeredModel.removeAttribute('id');
    model.sql = normalizedSql;
    model.database = this.context.database;
    model.collection = this;
    this.model = new Proxy(registeredModel, {
      get(target, key, receiver) {
        return key === '_schema' ? undefined : Reflect.get(target, key, receiver);
      },
    });
  }

  async removeFromDb(options?: QueryInterfaceDropTableOptions & { dropCollection?: boolean }) {
    if (options?.dropCollection !== false) return this.remove();
  }
}
