import { defineCollection } from '@nocobase/database';
import { COLLECTION } from '../../shared/constants';

/**
 * Per-render audit log. One row per `renderById` / `renderDirect` / `test` call.
 *
 * The full input/output payloads are kept only when
 * `carboneSettings.keepRawInDatabase` is true; otherwise we keep just the
 * sizes + MD5 so an admin can replay against the same template/version.
 *
 * `expiresAt` is set to `now + monitoringRetentionDays` so the cleanup job can
 * purge old rows without scanning everything.
 */
export default defineCollection({
  name: COLLECTION.renderLogs,
  title: 'Carbone Render Logs',
  autoGenId: true,
  createdAt: true,
  fields: [
    { name: 'action', type: 'string', allowNull: false, index: true }, // renderById | renderDirect | test
    { name: 'templateId', type: 'bigInt', index: true },
    { name: 'versionId', type: 'bigInt' },
    { name: 'carboneTemplateId', type: 'string', index: true },
    { name: 'format', type: 'string' },
    { name: 'filename', type: 'string' },

    { name: 'userId', type: 'bigInt', index: true },
    { name: 'roleName', type: 'string' },
    { name: 'ip', type: 'string' },

    { name: 'cacheKey', type: 'string', index: true },
    { name: 'cacheHit', type: 'boolean' },
    { name: 'inputMd5', type: 'string' },
    { name: 'inputBytes', type: 'integer' },
    { name: 'outputBytes', type: 'integer' },
    { name: 'durationMs', type: 'integer' },

    { name: 'status', type: 'string', index: true }, // success | error | rate_limited
    { name: 'errorMessage', type: 'text' },

    // Raw payload — stored only when settings.keepRawInDatabase = true.
    { name: 'inputData', type: 'json' },
    { name: 'outputAttachmentId', type: 'bigInt' },

    { name: 'expiresAt', type: 'date', index: true },
  ],
});
