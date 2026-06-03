import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'clusterManagerDoctorRuns',
  title: 'Cluster Manager Doctor Runs',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'runId', type: 'string', length: 64, unique: true, allowNull: false },
    { name: 'status', type: 'string', length: 20, defaultValue: 'running', allowNull: false },
    { name: 'durationMs', type: 'integer', defaultValue: 120000, allowNull: false },
    { name: 'progress', type: 'integer', defaultValue: 0, allowNull: false },
    { name: 'startedAt', type: 'date', allowNull: false },
    { name: 'deadlineAt', type: 'date', allowNull: false },
    { name: 'finishedAt', type: 'date', allowNull: true },
    { name: 'finishReason', type: 'string', length: 40, allowNull: true },
    { name: 'startedBy', type: 'string', length: 200, allowNull: true },
    { name: 'summary', type: 'json', allowNull: true },
    { name: 'report', type: 'json', allowNull: true },
    { name: 'error', type: 'text', allowNull: true },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;
