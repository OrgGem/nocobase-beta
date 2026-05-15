/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

export default class AddWebClientEmbedFields extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const db = (this as any).db;
    const queryInterface = db.sequelize.getQueryInterface();
    const DataTypes = db.sequelize.constructor['DataTypes'];
    const tableInfo = await queryInterface.describeTable('aiKnowledgeBases');

    if (!tableInfo.embedModelId) {
      await queryInterface.addColumn('aiKnowledgeBases', 'embedModelId', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
    }

    if (!tableInfo.embedMode) {
      await queryInterface.addColumn('aiKnowledgeBases', 'embedMode', {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: 'client',
      });
    }
  }
}
