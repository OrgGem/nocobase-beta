/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

export default class AddS3ConfigFieldsMigration extends Migration {
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

    await addIfMissing('storage_mode', { type: 'VARCHAR(20)', defaultValue: 'local', allowNull: true });
    await addIfMissing('s3_storage_id', { type: 'BIGINT', allowNull: true });
    await addIfMissing('s3_bucket', { type: 'VARCHAR(255)', allowNull: true });
    await addIfMissing('s3_region', { type: 'VARCHAR(100)', allowNull: true });
    await addIfMissing('s3_endpoint', { type: 'VARCHAR(500)', allowNull: true });
    await addIfMissing('s3_access_key_id', { type: 'VARCHAR(255)', allowNull: true });
    await addIfMissing('s3_secret_access_key', { type: 'VARCHAR(500)', allowNull: true });
    await addIfMissing('s3_key_prefix', { type: 'VARCHAR(255)', allowNull: true });
  }

  async down() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tablePrefix = (this as any).db.options.tablePrefix ?? '';
    const tableName = `${tablePrefix}embed_web_client_configs`;

    for (const col of [
      'storage_mode',
      's3_storage_id',
      's3_bucket',
      's3_region',
      's3_endpoint',
      's3_access_key_id',
      's3_secret_access_key',
      's3_key_prefix',
    ]) {
      await queryInterface.removeColumn(tableName, col).catch(() => {});
    }
  }
}
