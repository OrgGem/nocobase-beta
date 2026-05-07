/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

export default class AddCdnConfigFieldsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tablePrefix = (this as any).db.options.tablePrefix ?? '';
    const tableName = `${tablePrefix}embed_web_client_configs`;

    const tableExists = await queryInterface
      .describeTable(tableName)
      .then(() => true)
      .catch(() => false);

    if (!tableExists) return;

    const columns = await queryInterface.describeTable(tableName);

    const addIfMissing = async (colName: string, definition: object) => {
      if (!columns[colName]) {
        await queryInterface.addColumn(tableName, colName, definition);
      }
    };

    // modelSource: 'server' | 'cdn' | 'huggingface'
    await addIfMissing('model_source', { type: 'VARCHAR(20)', defaultValue: 'server', allowNull: true });
    // Full CDN URL to the model folder (used when modelSource = 'cdn')
    await addIfMissing('cdn_base_url', { type: 'VARCHAR(2048)', allowNull: true });
  }

  async down() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tablePrefix = (this as any).db.options.tablePrefix ?? '';
    const tableName = `${tablePrefix}embed_web_client_configs`;

    for (const col of ['model_source', 'cdn_base_url']) {
      await queryInterface.removeColumn(tableName, col).catch(() => {});
    }
  }
}
