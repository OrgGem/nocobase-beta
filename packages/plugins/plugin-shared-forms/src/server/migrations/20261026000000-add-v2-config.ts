// SPDX-License-Identifier: Apache-2.0

import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';

export default class AddSharedFormV2Config extends Migration {
  on = 'beforeLoad' as const;
  async up() {
    const collection = this.db.getCollection('sharedForms');
    if (!collection || !(await collection.existsInDb())) return;
    const table = collection.getTableNameWithSchema();
    const columns = await this.queryInterface.describeTable(table);
    if (!columns.v2Config)
      await this.queryInterface.addColumn(table, 'v2Config', { type: DataTypes.JSON, allowNull: true });
  }
}
