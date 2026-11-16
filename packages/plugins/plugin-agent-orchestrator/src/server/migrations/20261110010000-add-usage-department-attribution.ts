// SPDX-License-Identifier: Apache-2.0

import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';

export default class AddUsageDepartmentAttributionMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const collection = this.db.getCollection('agentExecutionSpans');
    const table = collection.getTableNameWithSchema();
    const query = this.db.sequelize.getQueryInterface();
    const columns = await query.describeTable(table);
    const definitions = {
      departmentId: { type: DataTypes.BIGINT, allowNull: true },
      departmentAttribution: { type: DataTypes.STRING(20), allowNull: true },
    };
    for (const [attribute, definition] of Object.entries(definitions)) {
      const field = collection.model.rawAttributes[attribute]?.field || attribute;
      if (!columns[field]) await query.addColumn(table, field, definition);
    }
  }

  async down() {
    // Keep the historical accounting attribution on rollback.
  }
}
