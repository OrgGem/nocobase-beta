/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DataTypes } from '@nocobase/database';
import type { Database } from '@nocobase/database';
import { Migration } from '@nocobase/server';
import type { QueryInterface } from 'sequelize';
import { ensureAgentOrchestratorIndexes } from '../utils/ensure-indexes';

type QueryInterfaceLike = Pick<QueryInterface, 'describeTable' | 'addColumn' | 'changeColumn'>;
type ColumnDefinition = Parameters<QueryInterface['addColumn']>[2];

async function tableColumns(queryInterface: QueryInterfaceLike, table: string) {
  try {
    return await queryInterface.describeTable(table);
  } catch {
    return null;
  }
}

async function addColumnsIfMissing(
  queryInterface: QueryInterfaceLike,
  table: string,
  collection: ReturnType<Database['getCollection']>,
  columns: Record<string, ColumnDefinition>,
) {
  const existing = await tableColumns(queryInterface, table);
  if (!existing) return;
  for (const [attribute, definition] of Object.entries(columns)) {
    const field = collection.model.rawAttributes[attribute]?.field || attribute;
    if (!existing[field]) await queryInterface.addColumn(table, field, definition);
  }
}

async function makeNullable(
  queryInterface: QueryInterfaceLike,
  table: string,
  collection: ReturnType<Database['getCollection']>,
  columns: string[],
) {
  const existing = await tableColumns(queryInterface, table);
  if (!existing) return;
  for (const attribute of columns) {
    const field = collection.model.rawAttributes[attribute]?.field || attribute;
    if (!existing[field]) continue;
    const column = existing[field] as { allowNull?: boolean };
    if (column.allowNull !== false) continue;
    const type = attribute.toLowerCase().includes('cost') ? DataTypes.FLOAT : DataTypes.INTEGER;
    await queryInterface.changeColumn(table, field, { type, allowNull: true });
  }
}

export default class AddUsagePricingSnapshotsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const { db } = this;
    const queryInterface = db.sequelize.getQueryInterface();
    const spansCollection = db.getCollection('agentExecutionSpans');
    const runsCollection = db.getCollection('agentLoopRuns');
    const spansTable = spansCollection.getTableNameWithSchema();
    const runsTable = runsCollection.getTableNameWithSchema();

    await addColumnsIfMissing(queryInterface, spansTable, spansCollection, {
      nativeIdentity: { type: DataTypes.STRING(512), allowNull: true },
      nativeActivityAt: { type: DataTypes.DATE, allowNull: true },
      usageIdentity: { type: DataTypes.STRING(512), allowNull: true },
      usageSessionId: { type: DataTypes.UUID, allowNull: true },
      usageMessageId: { type: DataTypes.STRING(200), allowNull: true },
      usageOccurredAt: { type: DataTypes.DATE, allowNull: true },
      model: { type: DataTypes.STRING(255), allowNull: true },
      provider: { type: DataTypes.STRING(100), allowNull: true },
      llmService: { type: DataTypes.STRING(100), allowNull: true },
      usageSource: { type: DataTypes.STRING(20), allowNull: true },
      usageOrigin: { type: DataTypes.STRING(40), allowNull: true },
      pricingStatus: { type: DataTypes.STRING(20), allowNull: true },
      priceSource: { type: DataTypes.STRING(40), allowNull: true },
      priceCurrency: { type: DataTypes.STRING(3), allowNull: true },
      priceVersion: { type: DataTypes.STRING(100), allowNull: true },
      priceInputPer1k: { type: DataTypes.FLOAT, allowNull: true },
      priceOutputPer1k: { type: DataTypes.FLOAT, allowNull: true },
      priceCachedInputPer1k: { type: DataTypes.FLOAT, allowNull: true },
      cachedTokens: { type: DataTypes.INTEGER, allowNull: true },
      reasoningTokens: { type: DataTypes.INTEGER, allowNull: true },
    });
    await makeNullable(queryInterface, spansTable, spansCollection, [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cost',
    ]);

    await addColumnsIfMissing(queryInterface, runsTable, runsCollection, {
      usageStatus: { type: DataTypes.STRING(20), allowNull: true },
      usageIncompleteSessions: { type: DataTypes.JSON, allowNull: true },
      pricingStatus: { type: DataTypes.STRING(20), allowNull: true },
    });
    await makeNullable(queryInterface, runsTable, runsCollection, [
      'totalInputTokens',
      'totalOutputTokens',
      'totalTokens',
      'totalCost',
    ]);
    await ensureAgentOrchestratorIndexes(db);
  }

  async down() {
    // Keep usage rows and historical price snapshots when rolling back code.
  }
}
