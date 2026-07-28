import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'skillRegistryArtifacts',
  title: 'Skill Registry Artifacts',
  autoGenId: true,
  createdAt: true,
  indexes: [
    { name: 'skill_registry_artifacts_digest', fields: ['digest'], unique: true },
    { name: 'skill_registry_artifacts_verification_created', fields: ['verificationStatus', 'createdAt'] },
    { name: 'skill_registry_artifacts_gc_checked', fields: ['gcCheckedAt', 'createdAt'] },
  ],
  fields: [
    { type: 'string', name: 'digest', length: 71, allowNull: false },
    { type: 'string', name: 'storageDriver', length: 32, defaultValue: 'filesystem', allowNull: false },
    { type: 'string', name: 'storageKey', length: 1000, allowNull: false },
    { type: 'string', name: 'format', length: 16, defaultValue: 'zip', allowNull: false },
    { type: 'string', name: 'contentType', length: 120, defaultValue: 'application/zip', allowNull: false },
    { type: 'bigInt', name: 'sizeBytes', allowNull: false },
    { type: 'bigInt', name: 'expandedSizeBytes', allowNull: false },
    { type: 'string', name: 'manifestDigest', length: 71, allowNull: false },
    { type: 'string', name: 'verificationStatus', length: 24, defaultValue: 'verified', allowNull: false },
    { type: 'date', name: 'gcCheckedAt', allowNull: true },
    { type: 'string', name: 'gcToken', length: 64, allowNull: true, hidden: true },
  ],
});
