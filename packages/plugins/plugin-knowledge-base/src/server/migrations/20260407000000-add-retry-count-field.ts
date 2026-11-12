// SPDX-License-Identifier: Apache-2.0

import { Migration } from '@nocobase/server';

export default class AddRetryCountField extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tableInfo = await queryInterface.describeTable('aiKnowledgeBaseDocuments');
    if (!tableInfo.retryCount) {
      await queryInterface.addColumn('aiKnowledgeBaseDocuments', 'retryCount', {
        type: (this as any).db.sequelize.constructor['DataTypes'].INTEGER,
        defaultValue: 0,
        allowNull: true,
      });
    }
  }
}
