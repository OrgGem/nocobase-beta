/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

export default class AddUsageGroups extends Migration {
  // Must run afterSync: plugin collections are only registered once the app has
  // loaded, and the new group tables must exist before seeding.
  on = 'afterSync' as const;

  async up() {
    const groupCollection = this.getGroupCollection();

    if (!groupCollection) {
      throw new Error('AI API usage groups migration could not resolve the aiApiUsageGroups collection.');
    }

    const configCollection = this.db.getCollection('aiApiConfig');
    let rateLimitPerMinute = 60;
    let quotaEnabled = false;
    if (configCollection && (await configCollection.existsInDb())) {
      // rateLimitPerMinute is no longer part of the collection definition, so
      // read the legacy column directly before dropping it.
      const tableName = configCollection.getTableNameWithSchema();
      const columns = await this.queryInterface.describeTable(tableName);
      if (columns.rateLimitPerMinute) {
        const legacyRateLimit = await this.readLegacyRateLimit(configCollection.quotedTableName());
        if (legacyRateLimit && legacyRateLimit > 0) {
          rateLimitPerMinute = legacyRateLimit;
        }
      }
      const config = await this.db.getRepository('aiApiConfig').findOne();
      if (config) {
        quotaEnabled = !!config.get('quotaEnabled');
      }
    }

    const existingDefault = await this.db.getRepository('aiApiUsageGroups').findOne({
      filter: { isDefault: true },
    });

    if (!existingDefault) {
      await this.db.getRepository('aiApiUsageGroups').create({
        values: {
          name: 'Default',
          isDefault: true,
          quotaMode: 'per_user',
          rateLimitPerMinute,
          enabled: quotaEnabled,
          periodType: 'monthly',
          timezone: 'UTC',
          requestLimit: null,
          totalTokenLimit: null,
          costLimit: null,
          currency: 'USD',
          rejectUnpricedModel: true,
          missingUsageBehavior: 'use_reserved',
          contextOverflowBehavior: 'reject',
        },
      });
    }

    if (configCollection && (await configCollection.existsInDb())) {
      const tableName = configCollection.getTableNameWithSchema();
      const columns = await this.queryInterface.describeTable(tableName);
      if (columns.rateLimitPerMinute) {
        await this.queryInterface.removeColumn(tableName, 'rateLimitPerMinute');
      }
    }

    await this.migrateLegacyQuotaPolicies();
  }

  async down() {
    // Recreate the rateLimitPerMinute column on aiApiConfig with a sensible default.
    const configCollection = this.db.getCollection('aiApiConfig');
    if (configCollection && (await configCollection.existsInDb())) {
      const tableName = configCollection.getTableNameWithSchema();
      const columns = await this.queryInterface.describeTable(tableName);
      if (!columns.rateLimitPerMinute) {
        await this.queryInterface.addColumn(tableName, 'rateLimitPerMinute', {
          type: 'INTEGER',
          allowNull: false,
          defaultValue: 60,
        });
      }
    }
  }

  private getGroupCollection() {
    return this.db.getCollection('aiApiUsageGroups');
  }

  private async readLegacyRateLimit(quotedTable: string): Promise<number | undefined> {
    const qi = this.db.sequelize.getQueryInterface();
    const [rows] = await this.db.sequelize.query(
      `SELECT ${qi.quoteIdentifier('rateLimitPerMinute')} FROM ${quotedTable} LIMIT 1`,
    );
    const first = (rows as Array<Record<string, unknown>> | undefined)?.[0];
    const value = Number(first?.rateLimitPerMinute);
    return Number.isFinite(value) ? value : undefined;
  }

  private async migrateLegacyQuotaPolicies() {
    const defaultGroup = await this.db.getRepository('aiApiUsageGroups').findOne({
      filter: { isDefault: true },
    });
    if (!defaultGroup) return;

    const policyCollection = this.db.getCollection('aiApiUserQuotaPolicies');
    const memberCollection = this.db.getCollection('aiApiGroupMembers');
    const bucketCollection = this.db.getCollection('aiApiGroupQuotaBuckets');
    if (!policyCollection || !memberCollection || !bucketCollection) return;

    const policies = (await this.db.getRepository('aiApiUserQuotaPolicies').find({
      pageSize: 1000,
    })) as unknown[];

    for (const policy of policies) {
      const userId = this.valueOf(policy, 'userId');
      if (userId === undefined || userId === null) continue;

      const existingMember = await this.db.getRepository('aiApiGroupMembers').findOne({
        filter: { userId },
      });
      if (!existingMember) {
        await this.db.getRepository('aiApiGroupMembers').create({
          values: { groupId: this.valueOf(defaultGroup, 'id'), userId },
        });
      }
    }
  }

  private valueOf(model: unknown, name: string): unknown {
    if (!model) return undefined;
    if (typeof (model as Record<string, unknown>).get === 'function') {
      return (model as Record<string, unknown>).get(name);
    }
    return (model as Record<string, unknown>)[name];
  }
}
