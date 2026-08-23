/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';
import { getSecretKeyInfo, encryptSecretIfPlain } from '../secret-box';

/**
 * password/passphrase were previously `type: 'password'` fields, which store a
 * one-way scrypt hash in a varchar(64) column. They are now `text` columns
 * holding AES-256-GCM ciphertext produced by secret-box.
 *
 * This migration widens the columns to TEXT. Existing scrypt hashes cannot be
 * converted to reversible ciphertext — users must re-enter the SFTP password /
 * passphrase once after upgrading (privateKey configs are unaffected).
 */
export default class extends Migration {
  async up() {
    const collection = this.db.getCollection('sftpStorageConfigs');
    if (!collection) {
      return;
    }

    const tableName = collection.getTableNameWithSchema();
    const queryInterface = this.db.sequelize.getQueryInterface();
    const description = await queryInterface.describeTable(tableName);

    if (description.password && description.password.type !== 'TEXT') {
      await queryInterface.changeColumn(tableName, 'password', {
        type: DataTypes.TEXT,
      });
    }

    if (description.passphrase && description.passphrase.type !== 'TEXT') {
      await queryInterface.changeColumn(tableName, 'passphrase', {
        type: DataTypes.TEXT,
      });
    }

    // privateKey is already a TEXT column, but unlike password/passphrase it
    // may still contain plaintext from before at-rest encryption was added.
    // Encrypt in place unless the key is ephemeral, in which case encrypting
    // would make credentials unrecoverable after the next restart.
    if (getSecretKeyInfo().ephemeral) {
      this.log?.warn?.(
        '[sftp-private-storage] Skipping privateKey encryption: no SFTP_STORAGE_SECRET_KEY / APP_KEY configured (ephemeral key).',
      );
      return;
    }

    const repository = collection.repository;
    const records = await repository.find({ fields: ['id', 'privateKey'], raw: true });
    for (const record of records) {
      const rawValue = record.privateKey ?? record['privateKey'];
      if (typeof rawValue !== 'string' || rawValue === '') {
        continue;
      }
      const encrypted = encryptSecretIfPlain(rawValue);
      if (encrypted !== rawValue) {
        await repository.update({ filterByTk: record.id, values: { privateKey: encrypted } });
      }
    }
  }
}
