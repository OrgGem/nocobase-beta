// SPDX-License-Identifier: Apache-2.0

import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';

export default class AddIndexLifecycleFields extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collection = this.db.getCollection('aiKnowledgeBaseDocuments');
    const table = collection.getTableNameWithSchema();
    let columns: Awaited<ReturnType<typeof queryInterface.describeTable>>;
    try {
      columns = await queryInterface.describeTable(table);
    } catch {
      // New installations create the collection from its definition during sync.
      return;
    }
    const additions = {
      indexRevision: { type: DataTypes.STRING, allowNull: true },
      activeIndexRevision: { type: DataTypes.STRING, allowNull: true },
      indexWorkerToken: { type: DataTypes.STRING, allowNull: true },
      indexWorkerStartedAt: { type: DataTypes.DATE, allowNull: true },
      indexDeleted: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
      retiredIndexRevisions: { type: DataTypes.JSON, allowNull: true },
      indexCleanupNeeded: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
      indexCleanupCursor: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
      indexCleanupAt: { type: DataTypes.DATE, allowNull: true },
      indexCleanupRoute: { type: DataTypes.JSON, allowNull: true },
      indexCleanupPending: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
      indexCleanupProgress: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    };
    for (const [name, definition] of Object.entries(additions)) {
      const field = collection.model.rawAttributes[name]?.field || name;
      if (!columns[field]) await queryInterface.addColumn(table, field, definition);
    }
  }
}
