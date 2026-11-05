/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';
import config from '../collections/ai-browser-config';

type TableIndex = { name: string; primary?: boolean; unique: boolean; fields: Array<{ attribute: string }> };

export default class EnsureConfigKey extends Migration {
  on = 'beforeLoad' as const;

  async up() {
    const existing = this.db.getCollection(config.name);
    const collection = existing || this.db.collection(config);
    try {
      if (!(await collection.existsInDb())) return;
      const table = collection.getTableNameWithSchema();
      const key = collection.getField('key').columnName();
      const id = collection.model.rawAttributes.id.field || 'id';
      const columns = await this.queryInterface.describeTable(table);
      await this.sequelize.transaction(async (transaction) => {
        const primaryKeys = Object.keys(columns).filter((name) => columns[name].primaryKey);
        if (primaryKeys.length !== 1 || primaryKeys[0] !== id) {
          if (this.db.inDialect('sqlite')) {
            // SQLite rebuilds the table; the transaction preserves all rows if the new key cannot be enforced.
            await this.queryInterface.changeColumn(
              table,
              key,
              {
                type: DataTypes.STRING,
                primaryKey: false,
                allowNull: false,
                unique: true,
              },
              { transaction },
            );
          } else {
            const indexes = (await this.queryInterface.showIndex(table, { transaction })) as TableIndex[];
            const primary = indexes.find((index) => index.primary || index.name === 'PRIMARY');
            if (!primary) throw new Error('AI Browser config primary key could not be resolved');
            const drop = this.db.inDialect('mysql', 'mariadb')
              ? 'DROP PRIMARY KEY'
              : `DROP CONSTRAINT ${this.db.quoteIdentifier(primary.name)}`;
            // Replace the composite key in one statement so MySQL's auto-increment id always stays indexed.
            await this.sequelize.query(
              `ALTER TABLE ${collection.quotedTableName()} ${drop}, ADD PRIMARY KEY (${this.db.quoteIdentifier(id)})`,
              { transaction },
            );
          }
        }
        const indexes = (await this.queryInterface.showIndex(table, { transaction })) as TableIndex[];
        if (!indexes.some((index) => index.unique && index.fields.length === 1 && index.fields[0].attribute === key)) {
          await this.queryInterface.addIndex(table, [key], { unique: true, transaction });
        }
      });
    } finally {
      if (!existing) this.db.removeCollection(config.name);
    }
  }
}
