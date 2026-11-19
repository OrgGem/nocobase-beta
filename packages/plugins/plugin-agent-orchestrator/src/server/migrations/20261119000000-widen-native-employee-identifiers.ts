// SPDX-License-Identifier: Apache-2.0

import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';

/**
 * AI Employee usernames are stored in the native message role as well as the employee
 * field. Preserve complete identifiers in native usage and execution projections.
 */
export default class WidenNativeEmployeeIdentifiers extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const collection = this.db.getCollection('agentExecutionSpans');
    if (!collection) return;
    const queryInterface = this.db.sequelize.getQueryInterface();
    const table = collection.getTableNameWithSchema();
    const columns = await queryInterface.describeTable(table);
    for (const attribute of ['role', 'employeeUsername', 'leaderUsername']) {
      const field = collection.model.rawAttributes[attribute]?.field || attribute;
      const column = columns[field];
      if (!column) continue;
      const match = /^(?:VARCHAR|CHARACTER VARYING|NVARCHAR)\s*\(\s*(\d+)\s*\)/i.exec(String(column.type));
      if (!match || Number(match[1]) >= 255) continue;
      await queryInterface.changeColumn(table, field, {
        type: DataTypes.STRING(255),
        allowNull: column.allowNull,
        ...(column.defaultValue == null ? {} : { defaultValue: column.defaultValue }),
      });
    }
  }

  async down() {
    // Preserve identifiers already stored at the larger native length.
  }
}
