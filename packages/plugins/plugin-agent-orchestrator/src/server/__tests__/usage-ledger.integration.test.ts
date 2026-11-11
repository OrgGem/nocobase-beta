/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { PluginAgentOrchestratorServer } from '../plugin';
import AddUsagePricingSnapshotsMigration from '../migrations/20261110000000-add-usage-pricing-snapshots';
import { TokenTracker } from '../services/TokenTracker';

type IndexField = string | { attribute?: string; name?: string };
type PhysicalIndex = { name?: string; unique?: boolean; fields?: IndexField[] };

function fieldsOf(index: PhysicalIndex) {
  return (index.fields || []).map((value) => {
    if (typeof value === 'string') return value;
    return value.attribute || value.name || '';
  });
}

function usesField(index: PhysicalIndex, field: string) {
  return fieldsOf(index).includes(field);
}

describe('agent execution span usage migration', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `agent-usage-migration-${process.pid}`,
      skipSupervisor: true,
    });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('adds the new SQLite columns without losing legacy usage rows and restores unique identities idempotently', async () => {
    const collection = app.db.getCollection('agentExecutionSpans');
    const tableName = collection.getTableNameWithSchema();
    const queryInterface = app.db.sequelize.getQueryInterface();
    const spans = app.db.getRepository('agentExecutionSpans');
    const now = new Date();
    const legacy = await spans.create({
      values: {
        rootRunId: 'legacy-migration-run',
        source: 'loop-runtime-usage',
        type: 'model_call',
        status: 'success',
        inputTokens: 28,
        outputTokens: 12,
        totalTokens: 40,
        cost: 0.35,
        metadata: { legacyReceipt: 'preserve-me' },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });

    const migration = new AddUsagePricingSnapshotsMigration({
      db: app.db,
      queryInterface,
      sequelize: app.db.sequelize,
    });
    const addedColumns = [
      'nativeIdentity',
      'nativeActivityAt',
      'usageIdentity',
      'usageSessionId',
      'usageMessageId',
      'usageOccurredAt',
      'model',
      'provider',
      'llmService',
      'usageSource',
      'usageOrigin',
      'pricingStatus',
      'priceSource',
      'priceCurrency',
      'priceVersion',
      'priceInputPer1k',
      'priceOutputPer1k',
      'priceCachedInputPer1k',
      'cachedTokens',
      'reasoningTokens',
    ];
    const indexes = (await queryInterface.showIndex(tableName)) as PhysicalIndex[];
    for (const index of indexes) {
      if (index.name && fieldsOf(index).some((field) => addedColumns.includes(field))) {
        await queryInterface.removeIndex(tableName, index.name);
      }
    }
    for (const attribute of addedColumns) {
      const field = collection.model.rawAttributes[attribute]?.field || attribute;
      await queryInterface.removeColumn(tableName, field);
    }
    const beforeMigration = await queryInterface.describeTable(tableName);
    expect(beforeMigration.nativeIdentity).toBeUndefined();
    expect(beforeMigration.usageIdentity).toBeUndefined();

    await migration.up();
    let migratedColumns = await queryInterface.describeTable(tableName);
    expect(migratedColumns.nativeIdentity).toBeTruthy();
    expect(migratedColumns.nativeActivityAt).toBeTruthy();
    expect(migratedColumns.usageIdentity).toBeTruthy();
    expect(migratedColumns.usageOccurredAt).toBeTruthy();
    const preserved = await spans.findOne({ filterByTk: legacy.id });
    expect(preserved?.get('inputTokens')).toBe(28);
    expect(preserved?.get('outputTokens')).toBe(12);
    expect(preserved?.get('totalTokens')).toBe(40);
    expect(preserved?.get('cost')).toBe(0.35);
    expect(preserved?.get('metadata')).toMatchObject({ legacyReceipt: 'preserve-me' });

    await migration.up();
    migratedColumns = await queryInterface.describeTable(tableName);
    expect(migratedColumns.usageIdentity).toBeTruthy();

    const firstIndexes = (await queryInterface.showIndex(tableName)) as PhysicalIndex[];
    for (const field of ['nativeIdentity', 'usageIdentity']) {
      const unique = firstIndexes.find((index) => index.unique && usesField(index, field));
      expect(unique?.name).toBeTruthy();
      if (!unique?.name) throw new Error(`No unique index found for ${field}.`);
      await queryInterface.removeIndex(tableName, unique.name);
      await queryInterface.addIndex(tableName, {
        name: unique.name,
        fields: [field],
        unique: false,
      });
    }

    await migration.up();
    const repairedIndexes = (await queryInterface.showIndex(tableName)) as PhysicalIndex[];
    for (const field of ['nativeIdentity', 'usageIdentity']) {
      expect(repairedIndexes.some((index) => !index.unique && usesField(index, field))).toBe(true);
      expect(repairedIndexes.filter((index) => index.unique && usesField(index, field))).toHaveLength(1);
    }

    const finalRow = await spans.findOne({ filterByTk: legacy.id });
    expect(finalRow?.get('rootRunId')).toBe('legacy-migration-run');
    expect(finalRow?.get('inputTokens')).toBe(28);
  });

  it('upgrades missing usage to one actual model call and recalculates run totals on replay', async () => {
    const run = await app.db.getRepository('agentLoopRuns').create({
      values: { rootRunId: 'sqlite-usage-run', goal: 'usage ledger', status: 'running' },
    });
    const sessionId = '30000000-0000-4000-8000-000000000001';
    const usageIdentity = 'ai-usage-event:30000000-0000-4000-8000-000000000001:message-1';
    const tracker = new TokenTracker({ app: { logger: app.logger }, db: app.db });
    const base = {
      usageIdentity,
      nativeIdentity: usageIdentity,
      sessionId,
      messageId: 'message-1',
      model: 'sqlite-test-model',
      provider: 'sqlite-test-provider',
      runId: run.id,
      rootRunId: 'sqlite-usage-run',
      source: 'ai_usage_event' as const,
      occurredAt: new Date(),
    };

    const missingId = await tracker.recordModelCallUsage({ ...base, usage: null });
    expect(missingId).toBeTruthy();
    const missing = await app.db.getRepository('agentExecutionSpans').findOne({ filter: { usageIdentity } });
    expect(missing?.get('usageSource')).toBe('missing');

    const actual = { inputTokens: 100, outputTokens: 25, totalTokens: 125 };
    const upgradedId = await tracker.recordModelCallUsage({ ...base, usage: actual });
    expect(upgradedId).toBe(missingId);
    const replayId = await tracker.recordModelCallUsage({ ...base, usage: actual });
    expect(replayId).toBe(missingId);

    const [usageRows, runAfterReplay] = await Promise.all([
      app.db.getRepository('agentExecutionSpans').find({ filter: { usageIdentity } }),
      app.db.getRepository('agentLoopRuns').findOne({ filterByTk: run.id }),
    ]);
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0].get('usageSource')).toBe('actual');
    expect(usageRows[0].get('inputTokens')).toBe(100);
    expect(usageRows[0].get('outputTokens')).toBe(25);
    expect(runAfterReplay?.get('totalInputTokens')).toBe(100);
    expect(runAfterReplay?.get('totalOutputTokens')).toBe(25);
    expect(runAfterReplay?.get('totalTokens')).toBe(125);
    expect(runAfterReplay?.get('usageStatus')).toBe('actual');
  });
});
