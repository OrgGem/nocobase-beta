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
  fields?: Array<{ attribute?: string } | string>;
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
  return (index.fields || []).map((field) => (typeof field === 'string' ? field : field?.attribute || '')).join(',');
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

    for (const index of collection.model.options.indexes || []) {
      if (!index.fields?.length) continue;

      const physicalFieldNames = index.fields
        .map((field) => resolvePhysicalField(collection, field))
        .filter((name): name is string => !!name);
      if (physicalFieldKeys.has(physicalFieldNames.join(','))) continue;

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

      const indexName = index.name || deriveIndexName(tableName, physicalFieldNames);
      if (physicalIndexNames.has(indexName)) continue;

      await queryInterface.addIndex(tableName, {
        name: indexName,
        fields: resolvedFields,
        unique: index.unique,
      });
      physicalIndexNames.add(indexName);
      physicalFieldKeys.add(physicalFieldNames.join(','));
    }
  }
}
