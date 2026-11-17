// SPDX-License-Identifier: Apache-2.0

import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';
import themeConfig from '../collections/theme-config';

type TableIndex = { name: string; primary?: boolean; unique: boolean; fields: Array<{ attribute: string }> };
type ExistingThemeRow = { id: number | string; uid?: string | null; is_default?: boolean | number | null };

export default class EnsureUniqueThemeUidAndBuiltins extends Migration {
  on = 'beforeLoad' as const;

  async up() {
    const existing = this.db.getCollection(themeConfig.name);
    const collection = existing || this.db.collection(themeConfig);

    try {
      if (!(await collection.existsInDb())) {
        return;
      }

      const table = collection.getTableNameWithSchema();
      const uidColumn = collection.getField('uid').columnName();
      const defaultColumn = collection.getField('default').columnName();
      const idColumn = collection.model.rawAttributes.id.field || 'id';

      await this.sequelize.transaction(async (transaction) => {
        const columns = await this.queryInterface.describeTable(table);
        if (!columns[uidColumn]) {
          await this.queryInterface.addColumn(table, uidColumn, { type: DataTypes.STRING }, { transaction });
        }

        const hasDefaultColumn = Boolean(columns[defaultColumn]);
        const selectDefault = hasDefaultColumn ? `, ${this.db.quoteIdentifier(defaultColumn)} AS is_default` : '';
        const [rows] = (await this.sequelize.query(
          `SELECT ${this.db.quoteIdentifier(idColumn)} AS id, ${this.db.quoteIdentifier(
            uidColumn,
          )} AS uid${selectDefault} FROM ${collection.quotedTableName()} ORDER BY ${this.db.quoteIdentifier(
            idColumn,
          )} ASC`,
          { transaction },
        )) as [ExistingThemeRow[], unknown];

        const grouped = new Map<string, ExistingThemeRow[]>();
        for (const row of rows) {
          if (typeof row.uid === 'string' && row.uid.length > 0) {
            const list = grouped.get(row.uid) || [];
            list.push(row);
            grouped.set(row.uid, list);
          }
        }

        const duplicateIds: Array<number | string> = [];
        for (const group of grouped.values()) {
          if (group.length <= 1) {
            continue;
          }
          const keeper = group.find((row) => Boolean(row.is_default)) || group[0];
          for (const row of group) {
            if (row.id !== keeper.id) {
              duplicateIds.push(row.id);
            }
          }
        }

        if (duplicateIds.length > 0) {
          await this.sequelize.query(
            `DELETE FROM ${collection.quotedTableName()} WHERE ${this.db.quoteIdentifier(idColumn)} IN (:ids)`,
            { replacements: { ids: duplicateIds }, transaction },
          );
        }

        const indexes = (await this.queryInterface.showIndex(table, { transaction })) as TableIndex[];
        const hasUniqueUidIndex = indexes.some(
          (index) => index.unique && index.fields.length === 1 && index.fields[0].attribute === uidColumn,
        );
        if (!hasUniqueUidIndex) {
          await this.queryInterface.addIndex(table, [uidColumn], { unique: true, transaction });
        }
      });
    } finally {
      if (!existing) {
        this.db.removeCollection(themeConfig.name);
      }
    }
  }
}
