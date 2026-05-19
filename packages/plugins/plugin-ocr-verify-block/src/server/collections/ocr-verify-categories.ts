import { defineCollection } from '@nocobase/database';
import { COLLECTION, DEFAULT_MAPPING, DEFAULT_SETTINGS } from '../../shared/constants';

export default defineCollection({
  name: COLLECTION.categories,
  title: 'OCR Verify Categories',
  fields: [
    { name: 'name', type: 'string', unique: true, required: true },
    { name: 'title', type: 'string', required: true },
    { name: 'description', type: 'text' },
    
    // API & Callback config
    { name: 'callbackUrl', type: 'text', allowNull: true },
    { name: 'callbackApiKey', type: 'text', allowNull: true },
    { name: 'callbackTimeoutMs', type: 'integer', defaultValue: DEFAULT_SETTINGS.callbackTimeoutMs },
    { name: 'acceptStatus', type: 'string', defaultValue: DEFAULT_SETTINGS.acceptStatus },
    { name: 'rejectStatus', type: 'string', defaultValue: DEFAULT_SETTINGS.rejectStatus },
    
    // Data Mapping Profile config
    { name: 'itemsPath', type: 'string', defaultValue: DEFAULT_MAPPING.itemsPath },
    { name: 'idPath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.idPath },
    { name: 'keyPath', type: 'string', defaultValue: DEFAULT_MAPPING.keyPath },
    { name: 'valuePath', type: 'string', defaultValue: DEFAULT_MAPPING.valuePath },
    { name: 'pagePath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.pagePath },
    { name: 'rectPath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.rectPath },
    { name: 'pointsPath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.pointsPath },
    { name: 'confidencePath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.confidencePath },
    { name: 'statusPath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.statusPath },
    
    { name: 'enabled', type: 'boolean', defaultValue: true },
    { name: 'createdBy', type: 'belongsTo', target: 'users', foreignKey: 'createdById' },
  ],
});
