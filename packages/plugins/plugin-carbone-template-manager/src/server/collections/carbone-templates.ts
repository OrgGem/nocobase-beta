import { defineCollection } from '@nocobase/database';
import { COLLECTION } from '../../shared/constants';

/**
 * Logical template entity. Holds the latest metadata and a pointer to the
 * current version. Actual files live inside Carbone (keyed by SHA-256
 * `carboneTemplateId`) and are mirrored as backups in the file-manager
 * storage selected in plugin settings.
 */
export default defineCollection({
  name: COLLECTION.templates,
  title: 'Carbone Templates',
  autoGenId: true,
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'name', type: 'string', allowNull: false, unique: true },
    { name: 'description', type: 'text' },
    { name: 'category', type: 'string' },
    { name: 'tags', type: 'json', defaultValue: [] },
    { name: 'enabled', type: 'boolean', defaultValue: true },

    { name: 'originalFileName', type: 'string' },
    { name: 'mimeType', type: 'string' },
    { name: 'fileSize', type: 'bigInt' },

    { name: 'defaultOutputFormat', type: 'string', defaultValue: 'pdf' },

    // Mirrored from the current version for fast access (read-only on the
    // template — always written through the version).
    { name: 'placeholderSchema', type: 'json', defaultValue: { d: [], warnings: [] } },
    { name: 'carboneTemplateId', type: 'string' },

    {
      type: 'belongsTo',
      name: 'currentVersion',
      target: COLLECTION.versions,
      foreignKey: 'currentVersionId',
      onDelete: 'SET NULL',
    },
    {
      type: 'hasMany',
      name: 'versions',
      target: COLLECTION.versions,
      foreignKey: 'templateId',
    },
  ],
});
