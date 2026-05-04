import { defineCollection } from '@nocobase/database';
import { COLLECTION } from '../../shared/constants';

/**
 * Content-addressable cache for rendered files.
 *
 *   cacheKey = md5(carboneTemplateId | stableJSON(data) | format)
 *
 * Because the key includes the SHA-256 from Carbone, version rollbacks
 * automatically use the right cache without any manual invalidation —
 * different versions hash to different cache rows.
 *
 * `outputAttachmentId` points at the rendered file inside the file-manager
 * storage chosen via `carboneSettings.cacheStorageId`. On lookup we verify
 * the attachment still exists, otherwise the row is treated as a miss and
 * the rendered output is re-stored.
 */
export default defineCollection({
  name: COLLECTION.renderCache,
  title: 'Carbone Render Cache',
  autoGenId: true,
  createdAt: true,
  fields: [
    { name: 'cacheKey', type: 'string', allowNull: false, unique: true, index: true },
    { name: 'templateId', type: 'bigInt', index: true },
    { name: 'versionId', type: 'bigInt' },
    { name: 'carboneTemplateId', type: 'string', index: true },
    { name: 'format', type: 'string' },
    { name: 'inputMd5', type: 'string' },

    { name: 'outputAttachmentId', type: 'bigInt', allowNull: false, index: true },
    { name: 'sizeBytes', type: 'bigInt' },

    { name: 'hitCount', type: 'integer', defaultValue: 0 },
    { name: 'lastHitAt', type: 'date' },
    { name: 'expiresAt', type: 'date' },
  ],
});
