/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

/**
 * Adds the agent-facing ACL columns to aiKnowledgeBases:
 *   - agentAccess: 'inherit' | 'explicit' | 'none' (default 'inherit')
 *   - allowedAgents: JSON array of AI Employee usernames granted explicit access
 *
 * Existing rows default to 'inherit', preserving the prior behavior where an
 * agent rides on the triggering user's access.
 */
export default class AddKbAgentAccessFields extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const db = (this as any).db;
    const queryInterface = db.sequelize.getQueryInterface();
    const DataTypes = db.sequelize.constructor['DataTypes'];
    const tablePrefix = db.options?.tablePrefix || '';
    const tableName = `${tablePrefix}aiKnowledgeBases`;

    const tableInfo = await queryInterface.describeTable(tableName).catch(() => null);
    if (!tableInfo) {
      return;
    }

    if (!tableInfo.agentAccess) {
      await queryInterface.addColumn(tableName, 'agentAccess', {
        type: DataTypes.STRING,
        defaultValue: 'inherit',
        allowNull: true,
      });
    }

    if (!tableInfo.allowedAgents) {
      await queryInterface.addColumn(tableName, 'allowedAgents', {
        type: DataTypes.JSON,
        allowNull: true,
      });
    }
  }
}
