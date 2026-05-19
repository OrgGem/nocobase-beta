import { defineCollection } from '@nocobase/database';
import { COLLECTION, DEFAULT_SETTINGS } from '../../shared/constants';

export default defineCollection({
  name: COLLECTION.settings,
  title: 'OCR Verify Settings',
  fields: [
    { name: 'pdfjsVersion', type: 'string', defaultValue: DEFAULT_SETTINGS.pdfjsVersion },
    { name: 'pdfjsCdnUrl', type: 'text', defaultValue: DEFAULT_SETTINGS.pdfjsCdnUrl },
    { name: 'pdfjsWorkerUrl', type: 'text', defaultValue: DEFAULT_SETTINGS.pdfjsWorkerUrl },
    { name: 'callbackUrl', type: 'text', allowNull: true },
    { name: 'callbackApiKey', type: 'text', allowNull: true },
    { name: 'callbackTimeoutMs', type: 'integer', defaultValue: DEFAULT_SETTINGS.callbackTimeoutMs },
    { name: 'acceptStatus', type: 'string', defaultValue: DEFAULT_SETTINGS.acceptStatus },
    { name: 'rejectStatus', type: 'string', defaultValue: DEFAULT_SETTINGS.rejectStatus },
    { name: 'autoSave', type: 'boolean', defaultValue: DEFAULT_SETTINGS.autoSave },
  ],
});
