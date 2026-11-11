/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database } from '@nocobase/database';

const INDEXED_COLLECTIONS = [
  'agentExecutionSpans',
  'agentHarnessProfiles',
  'agentHarnessProfileVersions',
  'agentLoopActionApprovals',
  'agentLoopArtifacts',
  'agentLoopCircuitStates',
  'agentLoopControlSettings',
  'agentLoopEvents',
  'agentLoopPathLocks',
  'agentLoopPatterns',
  'agentLoopRuns',
  'agentLoopSteps',
  'agentLoopUsageBuckets',
  'agentLoopWorktrees',
  'agentMemoryContexts',
  'orchestratorConfig',
  'skillRegistryInstallations',
] as const;

type PhysicalIndex = {
  name?: string;
  unique?: boolean;
  fields?: Array<{ attribute?: string; name?: string } | string>;
};

function resolvePhysicalField(collection: ReturnType<Database['getCollection']>, field: unknown): string | null {
  if (typeof field === 'string') {
    return collection.model.rawAttributes[field]?.field || field;
  }
  if (field && typeof field === 'object' && 'name' in field && typeof (field as { name: unknown }).name === 'string') {
    const name = (field as { name: string }).name;
    return collection.model.rawAttributes[name]?.field || name;
  }
  return null;
}

function deriveIndexName(tableName: unknown, fieldNames: string[]) {
  const table =
    typeof tableName === 'string' ? tableName : String((tableName as { tableName?: string })?.tableName ?? '');
  return `${table}_${fieldNames.join('_')}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

function physicalIndexFieldKey(index: PhysicalIndex): string {
  return (index.fields || [])
    .map((field) => (typeof field === 'string' ? field : field?.attribute || field?.name || ''))
    .join(',');
}

export async function ensureAgentOrchestratorIndexes(database: Database) {
  const queryInterface = database.sequelize.getQueryInterface();

  for (const collectionName of INDEXED_COLLECTIONS) {
    const collection = database.getCollection(collectionName);
    if (!collection) continue;

    const tableName = collection.getTableNameWithSchema();
    const physicalIndexes = (await queryInterface.showIndex(tableName)) as PhysicalIndex[];
    const physicalIndexNames = new Set(physicalIndexes.flatMap((index) => (index.name ? [index.name] : [])));
    // Track existing indexes by their ordered column composition so we skip an
    // index the framework's own db.sync() already created under a different name.
    const physicalFieldKeys = new Set(physicalIndexes.map(physicalIndexFieldKey));
    const uniqueFieldKeys = new Set(physicalIndexes.filter((index) => index.unique).map(physicalIndexFieldKey));

    for (const index of collection.model.options.indexes || []) {
      if (!index.fields?.length) continue;

      const physicalFieldNames = index.fields
        .map((field) => resolvePhysicalField(collection, field))
        .filter((name): name is string => !!name);
      const fieldKey = physicalFieldNames.join(',');
      if ((index.unique ? uniqueFieldKeys : physicalFieldKeys).has(fieldKey)) continue;

      const resolvedFields = index.fields.map((field) => {
        if (typeof field === 'string') {
          return collection.model.rawAttributes[field]?.field || field;
        }
        if (field && typeof field === 'object' && 'name' in field && typeof field.name === 'string') {
          return {
            ...field,
            name: collection.model.rawAttributes[field.name]?.field || field.name,
          };
        }
        return field;
      });

      let indexName = index.name || deriveIndexName(tableName, physicalFieldNames);
      if (physicalIndexNames.has(indexName)) {
        if (!index.unique) continue;
        // A non-unique index with the same name/columns does not enforce identity uniqueness.
        // Keep it intact and add a separately named unique index.
        const baseName = `${indexName}_unique`;
        indexName = baseName;
        let suffix = 2;
        while (physicalIndexNames.has(indexName)) indexName = `${baseName}_${suffix++}`;
      }

      await queryInterface.addIndex(tableName, {
        name: indexName,
        fields: resolvedFields,
        unique: index.unique,
      });
      physicalIndexNames.add(indexName);
      physicalFieldKeys.add(fieldKey);
      if (index.unique) uniqueFieldKeys.add(fieldKey);
    }
  }
}
