import { defineCollection } from '@nocobase/database';
import { COLLECTION, DEFAULT_MAPPING } from '../../shared/constants';

export default defineCollection({
  name: COLLECTION.mappingProfiles,
  title: 'OCR Verify Mapping Profiles',
  fields: [
    { name: 'name', type: 'string', unique: true, defaultValue: DEFAULT_MAPPING.name },
    { name: 'title', type: 'string', defaultValue: DEFAULT_MAPPING.title },
    { name: 'itemsPath', type: 'string', defaultValue: DEFAULT_MAPPING.itemsPath },
    { name: 'idPath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.idPath },
    { name: 'keyPath', type: 'string', defaultValue: DEFAULT_MAPPING.keyPath },
    { name: 'valuePath', type: 'string', defaultValue: DEFAULT_MAPPING.valuePath },
    { name: 'pagePath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.pagePath },
    { name: 'rectPath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.rectPath },
    { name: 'pointsPath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.pointsPath },
    { name: 'confidencePath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.confidencePath },
    { name: 'statusPath', type: 'string', allowNull: true, defaultValue: DEFAULT_MAPPING.statusPath },
    { name: 'enabled', type: 'boolean', defaultValue: DEFAULT_MAPPING.enabled },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
    { name: 'createdBy', type: 'belongsTo', target: 'users', foreignKey: 'createdById' },
  ],
});
