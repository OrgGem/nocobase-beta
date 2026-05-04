import { defineCollection } from '@nocobase/database';
import { COLLECTION } from '../../shared/constants';

/**
 * Immutable per-upload snapshot. Provides rollback (re-upload the backup file
 * to Carbone if Carbone has evicted it) and audit history.
 */
export default defineCollection({
  name: COLLECTION.versions,
  title: 'Carbone Template Versions',
  autoGenId: true,
  createdBy: true,
  createdAt: true,
  fields: [
    { name: 'templateId', type: 'bigInt', allowNull: false, index: true },
    { name: 'versionNumber', type: 'integer', allowNull: false },

    { name: 'carboneTemplateId', type: 'string', allowNull: false },
    { name: 'fileMd5', type: 'string', index: true },

    { name: 'originalFileName', type: 'string' },
    { name: 'mimeType', type: 'string' },
    { name: 'fileSize', type: 'bigInt' },

    { name: 'placeholderSchema', type: 'json', defaultValue: { d: [], warnings: [] } },
    { name: 'changeNote', type: 'text' },

    // FK → built-in `attachments` collection from plugin-file-manager.
    // Allows rollback even when Carbone evicts the SHA-256 entry.
    { name: 'fileBackupId', type: 'bigInt', allowNull: true, index: true },
  ],
});
