import { defineCollection } from '@nocobase/database';

/**
 * The `aiVisualizationBuilds` collection stores a single build record per
 * generation run. It mirrors the status / phase / runId / heartbeat shape of
 * `aiBuildGuideSpaces` so the same asynchronous build-queue machinery applies.
 *
 * New collections and columns are auto-synced to the database on
 * `yarn nocobase upgrade` (see AGENTS.md), so no migration file is required for
 * the initial definition.
 */
export default defineCollection({
  name: 'aiVisualizationBuilds',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
    },
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'text',
      name: 'requirement',
    },
    {
      type: 'string',
      name: 'dataSource',
    },
    {
      // Array of selected target collection names.
      type: 'json',
      name: 'collections',
    },
    {
      type: 'string',
      name: 'primaryCollection',
    },
    {
      type: 'string',
      name: 'llmService',
    },
    {
      type: 'string',
      name: 'model',
    },
    {
      // idle | building | completed | error
      type: 'string',
      name: 'status',
      defaultValue: 'idle',
    },
    {
      // idle | queued | analyzing | generating | completed | failed
      type: 'string',
      name: 'buildPhase',
      defaultValue: 'idle',
    },
    {
      // Current run identity, used as a stale-run guard.
      type: 'uuid',
      name: 'buildRunId',
    },
    {
      type: 'date',
      name: 'buildQueuedAt',
    },
    {
      type: 'date',
      name: 'buildStartedAt',
    },
    {
      type: 'date',
      name: 'buildHeartbeatAt',
    },
    {
      type: 'string',
      name: 'buildWorkerId',
    },
    {
      // The validated BlockSpec produced by the pipeline.
      type: 'json',
      name: 'blockSpec',
    },
    {
      // The generated Formily block schema.
      type: 'json',
      name: 'blockSchema',
    },
    {
      // Validator adjustments (removed / remapped references, unmet roles).
      type: 'json',
      name: 'adjustments',
    },
    {
      type: 'boolean',
      name: 'usedFallback',
      defaultValue: false,
    },
    {
      type: 'text',
      name: 'buildLog',
    },
    {
      type: 'text',
      name: 'errorMessage',
    },
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
    },
  ],
});
