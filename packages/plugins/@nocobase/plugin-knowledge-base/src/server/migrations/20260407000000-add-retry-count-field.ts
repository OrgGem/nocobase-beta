/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

export default class AddRetryCountField extends Migration {
  on = 'afterLoad';
  appVersion = '<1.0.0-alpha.1';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableInfo = await queryInterface.describeTable('aiKnowledgeBaseDocuments');
    if (!tableInfo.retryCount) {
      await queryInterface.addColumn('aiKnowledgeBaseDocuments', 'retryCount', {
        type: this.db.sequelize.constructor['DataTypes'].INTEGER,
        defaultValue: 0,
        allowNull: true,
      });
    }
  }
}
